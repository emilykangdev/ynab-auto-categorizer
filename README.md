# YNAB Auto Categorizer

Automate the categorization of uncategorized transactions in [You Need a Budget](https://www.ynab.com/) by reusing the categories
you previously applied to the same payees. The script looks at transaction history, determines the most likely category for each
uncategorized transaction, and optionally updates YNAB through the official API.

> ⚠️ Always run in `--dry-run` mode first to review the suggested changes before allowing the script to update your budget.

## Prerequisites

- Node.js 18 or later
- A YNAB personal access token ([create one in the YNAB web app](https://app.ynab.com/settings/developer))
- The ID of the budget you want to process (available in the YNAB URL when the budget is open)

Install dependencies:

```bash
npm install
```

## Usage

Export the required environment variables (you can also pass them as CLI flags):

```bash
export YNAB_ACCESS_TOKEN="<your-token>"
export YNAB_BUDGET_ID="<budget-id>"
```

Then evaluate the uncategorized transactions:

```bash
# Preview suggestions only
npm run auto-categorize -- --dry-run

# Apply the changes after reviewing the dry run output
npm run auto-categorize
```

### Useful flags

| Flag | Environment variable | Description |
| ---- | -------------------- | ----------- |
| `--since-date=YYYY-MM-DD` | `YNAB_SINCE_DATE` | Only inspect transactions created after the given date. |
| `--history-since-date=YYYY-MM-DD` | `YNAB_HISTORY_SINCE_DATE` | Limit the historical data that feeds the matching engine (defaults to `--since-date`). |
| `--min-confidence=0.75` | `YNAB_MIN_CONFIDENCE` | Require the chosen category to appear in at least the given percentage of historical matches (default `0.6`). |
| `--limit=25` | `YNAB_MAX_UPDATES` | Stop after suggesting/processing the specified number of transactions. |
| `--openai-api-key=...` | `OPENAI_API_KEY` | Enable the LLM fallback by providing an OpenAI API key. |
| `--llm-model=gpt-4o-mini` | `YNAB_LLM_MODEL` | Override the OpenAI model used for categorization suggestions. |
| `--llm-temperature=0.1` | `YNAB_LLM_TEMPERATURE` | Control the LLM sampling temperature (default `0.1`). |
| `--llm-max-tokens=200` | `YNAB_LLM_MAX_TOKENS` | Limit the size of the LLM response payload. |
| `--llm-base-url=https://api.openai.com/v1` | `YNAB_LLM_BASE_URL` / `OPENAI_BASE_URL` | Override the OpenAI-compatible endpoint. |
| `--access-token=...` | `YNAB_ACCESS_TOKEN` | Provide the token directly on the command line. |
| `--budget-id=...` | `YNAB_BUDGET_ID` | Provide the budget ID directly on the command line. |
| `--dry-run` | `YNAB_DRY_RUN` | Print planned updates without touching YNAB. |

Example dry-run output:

```
Fetching categories for budget 123...  
Fetching historical transactions since 2023-01-01...  
Built history from 428 transactions across 97 unique match keys.  
Fetching uncategorized transactions...  
Found 3 uncategorized transactions to evaluate.

Planned updates:
- 2024-04-03 | Blue Bottle Coffee | -$6.75 → Everyday Expenses / Coffee Shops (confidence: 86%, key: payee:abcd123)
    Based on 12/14 historical transactions (last: 2024-03-18 for -$6.25).
- 2024-04-02 | Lyft | -$18.22 → Transportation / Rideshare (confidence: 90%, key: name:lyft|account:xyz)
    Based on 27/30 historical transactions (last: 2024-03-29 for -$14.20).

Dry run enabled — no changes were sent to YNAB.
```

## How matching works

1. **Build history** – the script downloads past transactions (optionally filtered by `--history-since-date`), ignores transfers,
   split transactions, hidden/archived categories, and uncategorized items, then records how often each payee (and import payee name)
   was assigned to each category.
2. **Evaluate uncategorized transactions** – the script fetches the current uncategorized transactions, builds a list of match keys
   (payee ID, import payee name, and display name, each optionally combined with the account ID), and looks for historical matches.
3. **Score categories** – for every matching key, it picks the category that appears most frequently. The confidence score is the
   share of historical transactions for that key that used the suggested category. If no category clears the threshold and an
   OpenAI API key is configured, the script asks the LLM to choose from the valid category list using the transaction context and
   the summarized payee history.
4. **Apply updates** – if the confidence is above the configured threshold, the transaction is marked for update. When `--dry-run`
   is not specified the script performs a `PATCH /budgets/{budget_id}/transactions` call to update all pending transactions in a
   single request.

## Limitations

- Split transactions are skipped to avoid overwriting intentional category splits.
- Transfers (transactions with a linked account) are ignored because YNAB does not allow categories on transfers.
- Suggestions rely entirely on past behavior. New payees without history will remain uncategorized until you categorize them
  manually once.
- Hidden or archived categories are not considered for new assignments.

## Optional LLM fallback

When a transaction does not meet the historical confidence threshold, you can let an OpenAI model pick a category from the
available options:

1. Export an OpenAI-compatible API key:

   ```bash
   export OPENAI_API_KEY="sk-..."
   ```

2. (Optional) Customize the model and decoding behaviour:

   ```bash
   export YNAB_LLM_MODEL="gpt-4o-mini"
   export YNAB_LLM_TEMPERATURE="0.1"
   export YNAB_LLM_MAX_TOKENS="200"
   ```

3. Run the script as usual. Transactions that fail the deterministic scorer will be handed to the LLM along with the transaction
   details, valid categories, and a summary of how you categorized the payee in the past. The CLI only accepts category IDs that
   already exist in your budget, so the LLM cannot invent new categories.

## Troubleshooting

- If you receive `403` or `401` errors, double-check the access token and budget ID.
- YNAB enforces rate limits; if you process a very large number of transactions you might need to retry after waiting a minute.
- To inspect the raw API responses, add `DEBUG=1` to the environment and edit `src/autoCategorize.js` to log the relevant data
  before running the script.

## License

ISC

