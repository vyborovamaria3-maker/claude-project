# API Workflow

## Suggested order

1. Start with a broad market list or trending view.
2. Narrow to the token, pair, or wallet that matters.
3. Pull supporting fields only after the target is identified.
4. Keep the raw source payload alongside the interpreted summary.

## Common request goals

- Find new Pump.fun tokens.
- Check whether a token is active or stale.
- Inspect trader behavior around a token.
- Summarize market state before taking action.
- Compare a token across time windows.

## Request-shaping rules

- Ask for the smallest useful slice first.
- Prefer stable identifiers over display labels.
- Preserve time windows explicitly.
- Treat fast-moving market data as stale unless freshness is stated.

## Practical output sequence

- List results
- Select target
- Pull details
- Derive insights
- Export if needed
