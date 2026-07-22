# Data Model

## Common entities

- Token
  - `name`
  - `symbol`
  - `mint`
  - `createdAt`
  - `status`

- Market snapshot
  - `price`
  - `liquidity`
  - `volume`
  - `marketCap`
  - `holders`
  - `age`

- Trader activity
  - `buys`
  - `sells`
  - `netFlow`
  - `activeWallets`
  - `recentTrades`

- Pair or pool
  - `pairAddress`
  - `dex`
  - `baseMint`
  - `quoteMint`
  - `liquidity`

## Extraction guidance

- Use stable IDs as primary keys.
- Keep timestamps in UTC.
- Preserve raw numeric strings when precision matters.
- Separate inferred risk scores from raw source values.

## Interpretation guidance

- High holder concentration can be a risk signal.
- Liquidity jumps may indicate fresh activity or manipulation.
- Very young tokens need freshness warnings.
- A fast rank change is not the same as sustained demand.
