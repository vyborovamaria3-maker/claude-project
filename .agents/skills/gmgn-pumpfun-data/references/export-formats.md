# Export Formats

## Markdown table

Use for quick reading in chat.

Example columns:

- token
- mint
- price
- liquidity
- volume
- holders
- age
- risk

## CSV

Use when the result will be opened in Excel, Google Sheets, or another spreadsheet tool.

Rules:

- Keep one row per token, wallet, or pair.
- Use ISO 8601 timestamps.
- Keep numeric precision consistent.
- Avoid embedded commas unless properly escaped.

## JSON

Use when the result will be consumed by another tool.

Rules:

- Keep top-level keys stable.
- Separate `raw` and `derived` fields.
- Preserve source metadata.
- Do not flatten nested entities unless the downstream consumer needs it.

## Recommended schema

```json
{
  "source": "gmgn",
  "asset": "pumpfun-token",
  "rows": [],
  "generatedAt": "2026-07-06T00:00:00Z"
}
```
