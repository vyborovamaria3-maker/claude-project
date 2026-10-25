# Telegram multi-dataset ingestion

The Telegram collector consumes compact outputs from the repository's existing historical dataset
scanners and routes candidates into the same **telegram_channels** table and discovery refresh queue
used by public-web discovery. It does not create a second channel database.

## Supported sources

- **TGDataset / Zenodo**: generated files under **data/tgdataset/**, including
  **TGDataset_*.candidates.jsonl** and **telegram_seed_database.json**. Generate them with
  **python -m app.cli.tgdataset_filter**.
- **TeraGram**: **teragram_candidates.jsonl** and **telegram_seed_database.json** under the configured
  **TG_TERAGRAM_OUTPUT_DIR** (default: **data/teragram/**). Generate them with
  **python -m app.cli.teragram_filter --input-dir <server-controlled-dataset-root>**.
- **Additional datasets**: configure **TG_PUBLIC_WEB_DATASET_PATHS** with explicit JSON, JSONL, NDJSON,
  or CSV files/directories. Directory imports are recursive; only public usernames are accepted.
- **TGParser message archives** remain supported by the existing
  **python -m app.cli.telegram_import_tgparser** command. It imports archived messages directly into
  the shared message tables instead of treating message archives as channel-candidate lists.

## Runtime behavior

1. On startup and refresh ticks, the worker checks source file size and modification time. Unchanged
   outputs are not reparsed on every tick.
2. Candidate rows are streamed and upserted in batches. Duplicate usernames merge classifications,
   scores, subscriber estimates, and per-file provenance in **TelegramChannel.meta.dataset_import**.
3. Rows marked as scams, malformed usernames, and private invite links are skipped. Historical scores
   do not mark a channel as currently valid.
4. Imported channels enter the existing discovery registry as **candidate**, due immediately for live
   validation. The worker processes bounded batches; MTProto mode also adds successfully resolved
   channels to the realtime listener.
5. Message persistence and token extraction continue through the existing idempotent collector paths.

## Configuration

- **TG_DATASET_IMPORT_ENABLED=true** enables automatic ingestion of generated candidate files.
- **TG_PUBLIC_WEB_DATASET_PATHS=** optionally lists extra JSON, JSONL, NDJSON, or CSV files/directories.
- **TG_PUBLIC_WEB_REFRESH_BATCH_SIZE=25** bounds the number of channels processed per refresh tick.
- **TG_PUBLIC_WEB_SEED_DATABASE=data/tgdataset/telegram_seed_database.json** remains the small bootstrap
  list; the candidate JSONL files and both default seed databases are imported independently.

Relative paths are resolved from **solana-launcher/backend**. Dataset archive downloads/scans remain
explicit CLI operations so the background service never unexpectedly downloads huge datasets. Set
**TG_DATASET_IMPORT_ENABLED=false** to disable automatic ingestion; the legacy single seed file can
still be used for bootstrap discovery.
