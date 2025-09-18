#!/usr/bin/env node

const { parseArgs } = require('node:util');
const OpenAI = require('openai');
const { API } = require('ynab');

const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_LLM_MODEL = 'gpt-4o-mini';
const DEFAULT_LLM_TEMPERATURE = 0.1;
const DEFAULT_LLM_MAX_TOKENS = 200;

async function main() {
  try {
    const options = parseOptions();
    const ynabAPI = new API(options.accessToken);

    console.log(`Fetching categories for budget ${options.budgetId}...`);
    const categoryMap = await fetchCategoryMap(ynabAPI, options.budgetId);

    console.log(
      `Fetching historical transactions${options.historySinceDate ? ` since ${options.historySinceDate}` : ''}...`
    );
    const historyTransactions = await fetchTransactions(ynabAPI, options.budgetId, {
      sinceDate: options.historySinceDate,
    });
    const history = buildHistory(historyTransactions, categoryMap);
    console.log(
      `Built history from ${historyTransactions.length} transactions across ${history.size} unique match keys.`
    );

    const llmClient = options.llm ? createLlmClient(options.llm) : null;

    console.log(
      `Fetching uncategorized transactions${options.sinceDate ? ` since ${options.sinceDate}` : ''}...`
    );
    const uncategorizedResponse = await ynabAPI.transactions.getTransactions(
      options.budgetId,
      options.sinceDate,
      'uncategorized'
    );
    const uncategorizedTransactions = (uncategorizedResponse?.data?.transactions || []).filter(
      (tx) => !shouldSkipCandidate(tx)
    );
    console.log(
      `Found ${uncategorizedTransactions.length} uncategorized transactions to evaluate.`
    );

    const decisions = [];
    for (const tx of uncategorizedTransactions) {
      if (options.limit && decisions.length >= options.limit) {
        break;
      }

      const keys = generateKeys(tx);
      let match = selectBestHistoricalCategory(history, keys, categoryMap, options.minConfidence);

      if (!match && llmClient) {
        match = await selectCategoryWithLLM({
          client: llmClient,
          transaction: tx,
          keys,
          history,
          categoryMap,
          llmOptions: options.llm,
        });
      }

      if (match) {
        decisions.push({ transaction: tx, match });
      }
    }

    if (!decisions.length) {
      console.log('No transactions met the confidence threshold.');
      return;
    }

    logDecisions(decisions, options);

    if (options.dryRun) {
      console.log('\nDry run enabled — no changes were sent to YNAB.');
      return;
    }

    console.log('\nUpdating transactions in YNAB...');
    const payload = {
      transactions: decisions.map(({ transaction, match }) => ({
        id: transaction.id,
        category_id: match.categoryId,
      })),
    };

    await ynabAPI.transactions.updateTransactions(options.budgetId, payload);
    console.log(`Updated ${payload.transactions.length} transactions.`);
  } catch (error) {
    console.error('Auto-categorization failed.');
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  }
}

function parseOptions() {
  const { values } = parseArgs({
    options: {
      'access-token': { type: 'string' },
      'budget-id': { type: 'string' },
      'since-date': { type: 'string' },
      'history-since-date': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      limit: { type: 'string' },
      'min-confidence': { type: 'string' },
      'openai-api-key': { type: 'string' },
      'llm-model': { type: 'string' },
      'llm-temperature': { type: 'string' },
      'llm-max-tokens': { type: 'string' },
      'llm-base-url': { type: 'string' },
    },
  });

  const accessToken = values['access-token'] || process.env.YNAB_ACCESS_TOKEN;
  const budgetId = values['budget-id'] || process.env.YNAB_BUDGET_ID;
  const sinceDate = values['since-date'] || process.env.YNAB_SINCE_DATE;
  const historySinceDate =
    values['history-since-date'] || process.env.YNAB_HISTORY_SINCE_DATE || sinceDate;
  const dryRun = values['dry-run'] || parseBoolean(process.env.YNAB_DRY_RUN);
  const limit = parseInteger(values.limit || process.env.YNAB_MAX_UPDATES);
  const minConfidence = parseFloatOption(
    values['min-confidence'] || process.env.YNAB_MIN_CONFIDENCE,
    DEFAULT_MIN_CONFIDENCE
  );
  const openaiApiKey = values['openai-api-key'] || process.env.OPENAI_API_KEY;
  const llmModel =
    values['llm-model'] || process.env.YNAB_LLM_MODEL || (openaiApiKey ? DEFAULT_LLM_MODEL : undefined);
  const llmTemperature = parseFloatOption(
    values['llm-temperature'] || process.env.YNAB_LLM_TEMPERATURE,
    DEFAULT_LLM_TEMPERATURE
  );
  const llmMaxTokens = parseInteger(
    values['llm-max-tokens'] || process.env.YNAB_LLM_MAX_TOKENS
  );
  const llmBaseUrl = values['llm-base-url'] || process.env.YNAB_LLM_BASE_URL || process.env.OPENAI_BASE_URL;

  if (!accessToken) {
    throw new Error('Set YNAB_ACCESS_TOKEN (or use --access-token).');
  }

  if (!budgetId) {
    throw new Error('Set YNAB_BUDGET_ID (or use --budget-id).');
  }

  if (sinceDate && !isValidDateString(sinceDate)) {
    throw new Error(`Invalid since-date value: ${sinceDate}`);
  }

  if (historySinceDate && !isValidDateString(historySinceDate)) {
    throw new Error(`Invalid history-since-date value: ${historySinceDate}`);
  }

  if (minConfidence < 0 || minConfidence > 1) {
    throw new Error('min-confidence must be a decimal between 0 and 1.');
  }

  if (limit !== undefined && (Number.isNaN(limit) || limit <= 0)) {
    throw new Error('limit must be a positive integer.');
  }

  let llm;
  if (openaiApiKey) {
    llm = {
      provider: 'openai',
      apiKey: openaiApiKey,
      model: llmModel || DEFAULT_LLM_MODEL,
      temperature: clamp(llmTemperature, 0, 2, DEFAULT_LLM_TEMPERATURE),
      maxTokens: clampInteger(llmMaxTokens, 1, 2000, DEFAULT_LLM_MAX_TOKENS),
      baseUrl: llmBaseUrl,
    };
  }

  return {
    accessToken,
    budgetId,
    sinceDate: sinceDate || undefined,
    historySinceDate: historySinceDate || undefined,
    dryRun: Boolean(dryRun),
    limit,
    minConfidence,
    llm,
  };
}

async function fetchCategoryMap(ynabAPI, budgetId) {
  const response = await ynabAPI.categories.getCategories(budgetId);
  const groups = response?.data?.category_groups || [];
  const map = new Map();

  for (const group of groups) {
    const categories = group.categories || [];
    for (const category of categories) {
      map.set(category.id, {
        id: category.id,
        name: category.name,
        groupName: group.name,
        hidden: Boolean(category.hidden || group.hidden),
        deleted: Boolean(category.deleted),
      });
    }
  }

  return map;
}

async function fetchTransactions(ynabAPI, budgetId, { sinceDate } = {}) {
  const response = await ynabAPI.transactions.getTransactions(budgetId, sinceDate);
  return response?.data?.transactions || [];
}

function buildHistory(transactions, categoryMap) {
  const history = new Map();

  for (const tx of transactions) {
    if (shouldSkipHistoryTransaction(tx, categoryMap)) {
      continue;
    }

    const keys = generateKeys(tx);
    for (const entry of keys) {
      let stats = history.get(entry.key);
      if (!stats) {
        stats = {
          categories: new Map(),
          total: 0,
        };
        history.set(entry.key, stats);
      }

      stats.total += 1;
      const categoryStats = stats.categories.get(tx.category_id) || {
        occurrences: 0,
        lastDate: tx.date,
        lastTransaction: tx,
      };
      categoryStats.occurrences += 1;
      if (!categoryStats.lastDate || tx.date > categoryStats.lastDate) {
        categoryStats.lastDate = tx.date;
        categoryStats.lastTransaction = tx;
      }
      stats.categories.set(tx.category_id, categoryStats);
    }
  }

  return history;
}

function shouldSkipHistoryTransaction(tx, categoryMap) {
  if (!tx || tx.deleted) {
    return true;
  }

  if (!tx.category_id) {
    return true;
  }

  if (tx.transfer_account_id) {
    return true;
  }

  if (Array.isArray(tx.subtransactions) && tx.subtransactions.length > 0) {
    return true;
  }

  const category = categoryMap.get(tx.category_id);
  if (!category || category.hidden || category.deleted) {
    return true;
  }

  return false;
}

function shouldSkipCandidate(tx) {
  if (!tx || tx.deleted) {
    return true;
  }

  if (tx.transfer_account_id) {
    return true;
  }

  if (Array.isArray(tx.subtransactions) && tx.subtransactions.length > 0) {
    return true;
  }

  return false;
}

function selectBestHistoricalCategory(history, keys, categoryMap, minConfidence) {
  let best = null;

  keys.forEach((entry, index) => {
    const stats = history.get(entry.key);
    if (!stats) {
      return;
    }

    let bestForKey = null;
    for (const [categoryId, categoryStats] of stats.categories.entries()) {
      const category = categoryMap.get(categoryId);
      if (!category || category.hidden || category.deleted) {
        continue;
      }

      const confidence = categoryStats.occurrences / stats.total;
      const candidate = {
        key: entry.key,
        specificity: index,
        categoryId,
        confidence,
        occurrences: categoryStats.occurrences,
        total: stats.total,
        lastDate: categoryStats.lastDate,
        reference: categoryStats.lastTransaction,
        category,
        source: 'history',
      };

      if (!bestForKey) {
        bestForKey = candidate;
        continue;
      }

      if (
        candidate.occurrences > bestForKey.occurrences ||
        (candidate.occurrences === bestForKey.occurrences && candidate.lastDate > bestForKey.lastDate)
      ) {
        bestForKey = candidate;
      }
    }

    if (!bestForKey) {
      return;
    }

    if (bestForKey.confidence < minConfidence) {
      return;
    }

    if (!best) {
      best = bestForKey;
      return;
    }

    if (bestForKey.confidence > best.confidence) {
      best = bestForKey;
      return;
    }

    if (bestForKey.confidence === best.confidence) {
      if (bestForKey.specificity < best.specificity) {
        best = bestForKey;
        return;
      }

      if (bestForKey.specificity === best.specificity) {
        if (bestForKey.occurrences > best.occurrences) {
          best = bestForKey;
          return;
        }

        if (
          bestForKey.occurrences === best.occurrences &&
          bestForKey.lastDate > best.lastDate
        ) {
          best = bestForKey;
        }
      }
    }
  });

  return best;
}

function generateKeys(transaction) {
  const entries = [];
  const seen = new Set();

  const pushKey = (key) => {
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push({ key });
  };

  const accountId = transaction.account_id;
  const payeeId = transaction.payee_id;
  const payeeName = normalizeString(transaction.payee_name);
  const importName = normalizeString(transaction.import_payee_name);
  const originalImportName = normalizeString(transaction.import_payee_name_original);

  if (payeeId) {
    if (accountId) {
      pushKey(`payee:${payeeId}|account:${accountId}`);
    }
    pushKey(`payee:${payeeId}`);
  }

  if (importName) {
    if (accountId) {
      pushKey(`import:${importName}|account:${accountId}`);
    }
    pushKey(`import:${importName}`);
  }

  if (originalImportName) {
    if (accountId) {
      pushKey(`import-orig:${originalImportName}|account:${accountId}`);
    }
    pushKey(`import-orig:${originalImportName}`);
  }

  if (payeeName) {
    if (accountId) {
      pushKey(`name:${payeeName}|account:${accountId}`);
    }
    pushKey(`name:${payeeName}`);
  }

  return entries;
}

function logDecisions(decisions, options) {
  console.log('\nPlanned updates:');
  for (const { transaction, match } of decisions) {
    const amount = formatAmount(transaction.amount);
    const confidencePct =
      typeof match.confidence === 'number' ? Math.round(match.confidence * 100) : undefined;
    const referenceDate = match.reference?.date || 'unknown date';
    const referenceAmount = match.reference ? formatAmount(match.reference.amount) : 'n/a';
    const payee = transaction.payee_name || transaction.import_payee_name || 'Unknown Payee';

    const confidenceText =
      confidencePct === undefined ? 'n/a' : `${confidencePct}%`;
    const groupName = match.category?.groupName || 'Unknown Group';
    const categoryName = match.category?.name || 'Unknown Category';
    const keyLabel = match.key || (match.consideredKeys ? match.consideredKeys.join(', ') : 'n/a');

    console.log(
      `- ${transaction.date} | ${payee} | ${amount} → ${groupName} / ${categoryName} ` +
        `(confidence: ${confidenceText}, key: ${keyLabel}, source: ${match.source || 'unknown'})`
    );

    if (match.source === 'history') {
      console.log(
        `    Based on ${match.occurrences}/${match.total} historical transactions (last: ${referenceDate} for ${referenceAmount}).`
      );
    } else if (match.source === 'llm') {
      const reason = match.reason ? match.reason.trim() : 'No explanation provided.';
      console.log(
        `    Selected by LLM model ${options.llm?.model || 'unknown'} using keys [${
          match.consideredKeys?.join(', ') || 'n/a'
        }]. Reason: ${reason}`
      );
    }
  }

  if (options.limit && decisions.length === options.limit) {
    console.log(`\nLimit reached (${options.limit} transactions).`);
  }
}

function createLlmClient(llmOptions) {
  if (!llmOptions || llmOptions.provider !== 'openai') {
    return null;
  }

  const config = { apiKey: llmOptions.apiKey };
  if (llmOptions.baseUrl) {
    config.baseURL = llmOptions.baseUrl;
  }

  return new OpenAI(config);
}

async function selectCategoryWithLLM({
  client,
  transaction,
  keys,
  history,
  categoryMap,
  llmOptions,
}) {
  if (!client || !llmOptions) {
    return null;
  }

  const categories = Array.from(categoryMap.values()).filter((category) => !category.hidden && !category.deleted);
  if (!categories.length) {
    return null;
  }

  const payload = buildLlmPayload({ transaction, keys, history, categoryMap, categories });

  try {
    const completion = await client.chat.completions.create({
      model: llmOptions.model,
      temperature: llmOptions.temperature,
      max_tokens: llmOptions.maxTokens,
      messages: [
        {
          role: 'system',
          content:
            'You categorize YNAB budget transactions. Reply with a JSON object {"categoryId": string, "confidence": number, "reason": string}. Use "NONE" when no category fits.',
        },
        {
          role: 'user',
          content: JSON.stringify(payload),
        },
      ],
    });

    const rawContent = completion?.choices?.[0]?.message?.content;
    const parsed = parseLlmJson(rawContent);
    if (!parsed) {
      console.warn('Failed to parse LLM response, skipping transaction.', rawContent);
      return null;
    }

    const categoryId = typeof parsed.categoryId === 'string' ? parsed.categoryId.trim() : undefined;
    if (!categoryId || categoryId === 'NONE') {
      return null;
    }

    const category = categoryMap.get(categoryId);
    if (!category || category.hidden || category.deleted) {
      console.warn(`LLM chose an invalid category (${categoryId}); ignoring.`);
      return null;
    }

    const confidenceValue =
      typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
        ? parsed.confidence
        : undefined;

    return {
      source: 'llm',
      categoryId,
      category,
      confidence: confidenceValue,
      key: 'llm',
      consideredKeys: keys.map((entry) => entry.key),
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('LLM request failed:', message);
    return null;
  }
}

function buildLlmPayload({ transaction, keys, history, categoryMap, categories }) {
  const payeeHistory = keys
    .map((entry) => {
      const stats = history.get(entry.key);
      if (!stats) {
        return undefined;
      }

      const candidates = Array.from(stats.categories.entries())
        .map(([categoryId, categoryStats]) => {
          const category = categoryMap.get(categoryId);
          return {
            categoryId,
            categoryName: category?.name,
            groupName: category?.groupName,
            occurrences: categoryStats.occurrences,
            share: Number((categoryStats.occurrences / stats.total).toFixed(3)),
            lastDate: categoryStats.lastDate,
            lastAmount: categoryStats.lastTransaction
              ? formatAmount(categoryStats.lastTransaction.amount)
              : undefined,
          };
        })
        .sort((a, b) => b.occurrences - a.occurrences)
        .slice(0, 5);

      return {
        key: entry.key,
        totalTransactions: stats.total,
        topCategories: candidates,
      };
    })
    .filter(Boolean);

  return {
    instructions:
      'Select the most appropriate categoryId for the transaction. Only use categoryId values that appear in candidateCategories.',
    transaction: {
      id: transaction.id,
      date: transaction.date,
      amount: transaction.amount,
      formattedAmount: formatAmount(transaction.amount),
      payeeName: transaction.payee_name,
      importPayeeName: transaction.import_payee_name,
      originalImportName: transaction.import_payee_name_original,
      memo: transaction.memo,
      accountId: transaction.account_id,
    },
    candidateCategories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      group: category.groupName,
    })),
    payeeHistory,
    expectedResponse:
      'Respond with a JSON object {"categoryId": string, "confidence": number between 0 and 1, "reason": string}.',
  };
}

function parseLlmJson(content) {
  if (!content) {
    return undefined;
  }

  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) {
      return undefined;
    }

    try {
      return JSON.parse(match[0]);
    } catch (innerError) {
      return undefined;
    }
  }
}

function formatAmount(milliunits) {
  const value = milliunits / 1000;
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;
}

function normalizeString(value) {
  if (!value) {
    return undefined;
  }

  const normalized = value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();

  return normalized || undefined;
}

function isValidDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseBoolean(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseInteger(value) {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseFloatOption(value, fallback) {
  if (!value && value !== 0) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function clamp(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function clampInteger(value, min, max, fallback) {
  if (!value && value !== 0) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  if (parsed < min) {
    return min;
  }
  if (parsed > max) {
    return max;
  }
  return parsed;
}

if (require.main === module) {
  main();
}

