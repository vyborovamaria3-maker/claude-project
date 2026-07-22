# Pump.fun Data Sources

This project can use an external Pump.fun dataset as a local warm cache before falling back to the existing Helius/Solscan/Pump.fun fetch pipeline.

## Best candidates found

| Source | Fit | Data shape | Notes |
| --- | --- | --- | --- |
| Bitquery Pump.fun historical dataset/API | Best full-coverage option | Trades, trader wallets, token metadata, market cap, supply, tx hash | Supports historical `dataset: combined`; likely requires API key or paid plan for serious use. |
| Kaggle: Pump Fun API Solana Tokens Info | Token metadata seed | Tokens/coins metadata | Useful to seed `dev_tokens`; verify file columns before importing. |
| Kaggle: SSS - Pump Fun Tokens Graduation 2025 | Graduation/migration seed | Graduated tokens | Useful for migration labels, not a complete trade database. |
| Apify Pump Fun Crypto Coin Scraper | Scraped listings | Token listings/market data | Good for recent listings; verify trade-history depth. |
| `haccer/pumpfun-research` GitHub repo | Wallet-level CSV generator | Wallet trades and per-mint CSVs | Not a global database, but useful for generating local CSV around known wallets. |
| Wallet Master / Solana analytics APIs | Paid API candidate | Trades, creators, address registry | Coverage/pricing must be verified with the provider. |

## Import format

Use the CLI importer for CSV, JSON array, or JSONL/NDJSON files:

```bash
npm run pumpfun:import -- --file ./data/pumpfun-trades.csv --kind trades --source bitquery
npm run pumpfun:import -- --file ./data/pumpfun-tokens.jsonl --kind tokens --source kaggle
```

The importer writes to `data/trade.db` by default.

## Required trade fields

The importer accepts common aliases, but each trade row must resolve to:

- `mint`
- `signature` / `tx` / `hash`
- `timestamp` / `time` / `block_time`
- `trader` / `wallet` / `userAddress`
- `type` / `side` as buy or sell
- `amountSol`
- `amountTokens`
- `priceSol` or enough amounts to calculate it

Rows are stored in `token_trades` and are consumed automatically by `loadTokenTrades` before external fetches.

## Required token fields

Each token row must resolve to:

- `mint`
- `creator` / `dev` / `deployer`

Optional fields include `symbol`, `name`, `createdAt`, `marketCapUsd`, `athUsd`, `isMigrated`, and `totalSupply`.

Rows are stored in `dev_tokens` for creator resolution and Dev Forensics reuse.

## Recommended workflow

1. Download candidate files into `data/` without committing large datasets.
2. Import token metadata first if available.
3. Import trades second.
4. Open a known mint in the app; `loadTokenTrades` should hit SQLite before Helius/Solscan.
5. Keep API keys in `.env.local`; do not hardcode provider credentials.
