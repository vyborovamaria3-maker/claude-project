---
name: gmgn-pumpfun-data
description: Retrieve and interpret Pump.fun data using the GMGN/OpenAPI demo workflow. Use when you need token, trader, market, holder, pair, or trend data from Pump.fun-related sources, or when building extraction and monitoring flows around Solana memecoin markets.
---

# GMGN Pump.fun Data

## Overview

Use this skill to gather Pump.fun-related market data through GMGN-style endpoints and turn it into something usable for analysis, monitoring, or downstream automation.

## Core Workflow

1. Identify the data question
   - Token discovery
   - Trader activity
   - Market trend
   - Holder distribution
   - Pair or pool state
   - Transaction flow

2. Choose the narrowest useful source
   - Prefer the GMGN/OpenAPI data path used by the demo repo when the task is about Pump.fun market data.
   - If the task is really on-chain and needs raw truth, prefer Solana transaction/account data.
   - If the task is only about rendering or UI, do not over-fetch.

3. Normalize the output
   - Keep token identifiers stable.
   - Separate raw data from interpreted findings.
   - Preserve timestamps, amounts, prices, and source references.

4. Pick the delivery format
   - Markdown table for quick inspection.
   - CSV when the result needs to be opened in spreadsheets.
   - JSON when the result will be piped into another tool or automation.

5. Use the formatter path
   - For Solana-backed checks, gather the source data with MCP tools first, then format it with the local scripts in this skill.
   - For GMGN-style extracts, normalize into the same schema before rendering.

## Data Shapes to Prefer

- Token profile: name, symbol, mint, chain, status, creation time
- Market snapshot: price, liquidity, volume, market cap, holders, age
- Trader activity: buys, sells, net flow, wallet counts, recent actions
- Pair state: base/quote, pool, DEX venue, liquidity changes
- Trend data: ranking, momentum, change over time
- Risk signals: extreme concentration, sudden spikes, low liquidity, broken pairs

## GMGN/OpenAPI Workflow

- Use the demo workflow as the source of truth for how data is organized and consumed.
- Treat `trending`, `positions`, and decision logs as the main user-facing data surfaces.
- When the user asks for market state, start with a list view first, then drill into one token or one wallet.
- When the user asks for an action, separate signal generation from execution.

For concrete extraction and request-shaping notes, see [references/api-workflow.md](references/api-workflow.md).

## Practical Rules

- Keep the scope on Solana and Pump.fun.
- If a requested field is not available from the current source, say so instead of inventing it.
- Prefer raw values first, then derived metrics.
- Surface source freshness when data may change quickly.
- Treat the demo repo as a workflow reference, not as a generic web scraping template.
- When the user asks for a spreadsheet-friendly result, use the export format reference.
- When the user asks for continuous discovery, use the monitoring reference.

## Output Pattern

When answering, format results as:

1. Source used
2. Data extracted
3. Important interpretation
4. Caveats or missing fields
5. Next action if needed

## Response Templates

### Table

```text
| token | mint | price | liquidity | volume | holders | age | risk |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| ... | ... | ... | ... | ... | ... | ... | ... |
```

### JSON

```json
{
  "source": "gmgn",
  "scope": "pumpfun",
  "generatedAt": "2026-07-06T00:00:00Z",
  "rows": [
    {
      "token": "example",
      "mint": "exampleMint",
      "price": 0.0,
      "liquidity": 0.0,
      "volume": 0.0,
      "holders": 0,
      "age": "0m",
      "risk": "low"
    }
  ]
}
```

## References

Read [references/data-model.md](references/data-model.md) before doing multi-field Pump.fun analysis or building extraction flows.
Read [references/export-formats.md](references/export-formats.md) when the result should be a table, CSV, or JSON payload.
Read [references/monitoring.md](references/monitoring.md) when the task is to watch for new Pump.fun tokens or market changes over time.
Read [references/mcp-workflow.md](references/mcp-workflow.md) when the source data comes from Solana MCP tools and needs to be formatted locally.
