# Importing the Solana Memecoin Research Dataset

Source: [ian05012/solana-memecoin-dataset](https://github.com/ian05012/solana-memecoin-dataset), MIT license. The importer pins the source to commit \`7070d00e1e4492f8604d988549d91785cc5f43f7\` and records each local Parquet SHA-256.

The dataset describes roughly 20 days (2026-06-10 through 2026-06-30), not complete Solana history. It reports:
- 44,460 token snapshots with approximately 80 detection-time features and hindsight labels;
- 9,500,565 wallet/token trade rows;
- 272,426 15-minute OHLCV candles;
- 506,628 sequence buckets;
- 11,817 wallet profiles;
- 15,493 wallet funding edges.

## Why these are separate tables

The source trade schema is only \`wallet, token_address, side, amount_usd, ts\`. It does **not** include a transaction signature, slot, raw token quantity, quote-mint/amount, SOL amount, fee or instruction/leg index. The importer therefore does **not** fabricate these fields and does not write \`token_trades\`, \`token_trade_fills\`, inventory, wallet PnL, or authoritative trade caches.

Instead it stores source records in \`external_memecoin_*\` tables in the same SQLite file:
- \`external_memecoin_trades\`: one row for every input source row, keyed by \`dataset_id, source_file, source_row\`. Identical-looking rows are retained because repeated/partial fills are valid. \`side_raw\`, \`amount_usd_raw\`, \`ts_raw\`, file name, and zero-based source row preserve source interpretation/provenance. Invalid normalized fields are marked \`quality_status='incomplete'\` with reasons; they are not silently dropped.
- \`external_memecoin_tokens\`: snapshot identity, common price/market-cap/return fields and a \`raw_json\` containing the full source row, including features and labels.
- \`external_memecoin_ohlcv\`, \`external_memecoin_sequences\`, \`external_memecoin_wallets\`, \`external_memecoin_wallet_funding\`: normalized query columns plus the full \`raw_json\` source row.
- \`external_memecoin_dataset_catalog\` and \`external_memecoin_import_files\`: source commit, license, import status, per-file SHA-256, row counts and quality counts.

File hashes and row positions make an import reproducible and idempotent. Re-importing an unchanged shard skips it. If a shard changes, only rows from that exact source file are replaced, in one transaction. No duplicate detection is performed on wallet/token/time/amount because that would incorrectly collapse legitimate repeated fills.

The importer streams Parquet in batches and does not load all 9.5M trade rows into RAM. It requires \`pyarrow\`; the Python regression suite itself uses only the standard library.

## Safe runbook

Run from \`solana-launcher\`. Stop the app/collector while importing a large database.

\`\`\`bash
# 1. Obtain the dataset outside the application repository and pin its revision.
git clone https://github.com/ian05012/solana-memecoin-dataset.git /absolute/path/solana-memecoin-dataset
git -C /absolute/path/solana-memecoin-dataset checkout 7070d00e1e4492f8604d988549d91785cc5f43f7

# 2. Install the Parquet reader.
python3 -m pip install pyarrow

# 3. Dry-run first. This hashes all files, validates the schema and checks
#    the documented row counts; it does not open or write the database.
npm run dataset:memecoin-import -- \
  --source-dir /absolute/path/solana-memecoin-dataset/data \
  --db /absolute/path/solana-launcher/data/trade.db

# 4. For an existing DB, choose a NEW backup destination on a volume with
#    enough free space. --apply refuses to modify an existing DB without it.
npm run dataset:memecoin-import -- \
  --source-dir /absolute/path/solana-memecoin-dataset/data \
  --db /absolute/path/solana-launcher/data/trade.db \
  --apply \
  --backup-path /absolute/path/backups/trade.db.before-memecoin-import.sqlite

# 5. Verify importer logic (no source data required).
npm run dataset:memecoin-test
\`\`\`

The import requires all ten expected Parquet files. If documented row counts differ, it fails closed; use \`--allow-count-mismatch\` only after reviewing the local source revision and manifest. The full source Parquet files are not committed to this application repository.

## Useful queries

\`\`\`sql
-- Import status and source provenance.
SELECT dataset_id, status, expected_rows, imported_rows, license, source_commit
FROM external_memecoin_dataset_catalog;

SELECT source_file, source_rows, imported_rows, incomplete_rows, source_sha256, imported_at
FROM external_memecoin_import_files
ORDER BY source_file;

-- Buy/sell volume by token using only the imported research sample.
SELECT token_address, side, COUNT(*) AS rows, SUM(amount_usd) AS volume_usd,
       COUNT(DISTINCT wallet) AS wallets
FROM external_memecoin_trades
WHERE dataset_id = 'ian05012/solana-memecoin-dataset@7070d00e1e4492f8604d988549d91785cc5f43f7'
GROUP BY token_address, side
ORDER BY volume_usd DESC;

-- Review malformed/incomplete source rows without deleting them.
SELECT source_file, quality_reasons_json, COUNT(*) AS rows
FROM external_memecoin_trades
WHERE quality_status <> 'valid'
GROUP BY source_file, quality_reasons_json
ORDER BY rows DESC;

-- Join sample trades to the token snapshot rows by mint/token address.
SELECT t.wallet, t.side, t.amount_usd, t.ts_epoch, s.sample_id, s.symbol,
       s.captured_at_epoch, s.market_cap_usd, s.max_return_24h, s.reaches_2x
FROM external_memecoin_trades t
LEFT JOIN external_memecoin_tokens s
  ON s.dataset_id=t.dataset_id AND s.token_address=t.token_address
WHERE t.dataset_id = 'ian05012/solana-memecoin-dataset@7070d00e1e4492f8604d988549d91785cc5f43f7'
ORDER BY t.ts_epoch
LIMIT 100;
\`\`\`

## Interpretation limits

- \`max_return_*\`, \`reaches_2x\`, \`runner_peak_x\`, \`staged_exit_return\` and other forward-return columns are **post-observation labels**. Never feed them into a model as contemporaneous features; that is target leakage.
- The README warns of survivorship bias: tokens had to survive long enough to be detected, so reported win/2x rates are not population-wide base rates.
- OHLCV covers label windows (up to 3 days after detection), not full market history, and a few glitch candles remain.
- \`amount_usd\` alone is not enough to reconstruct token quantities, exact fills, realized inventory/cost basis, fees, or reliable per-wallet PnL. The source wallet \`avg_pnl_ratio\` is a third-party feature, not our canonical accounting.
- Imported rows are research evidence only. They do not prove on-chain transactions or Solana finality and must not be merged into authoritative PnL without independent signature-level reconstruction.

After a successful full import, the documented total is 10,351,389 rows across all six logical datasets. The importer reports the actual per-file counts and any incomplete trade rows.
