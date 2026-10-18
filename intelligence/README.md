# Intelligence — PR-5 destination inbox and entity registry

This is a **new isolated PostgreSQL destination**. It is not a replacement for
the existing x-collector and tg-collector databases or blockchain SQLite.

- Apply migrations/001_entity_registry.sql through a reviewed, checksum-
  controlled migration runner to the destination database only.
- An input RegistryEvent must contain a stable sourceSystem/eventKind/eventKey,
  schemaVersion, canonical entityRefs and a source-specific evidenceRef.
- ingestRegistryEvent(tx, event) MUST run inside the caller's open PG
  transaction. Commit destination before acknowledging a source outbox event.
- Inbox deduplicates at-least-once deliveries by event identity. A crash
  between destination COMMIT and source ACK results in safe replay.
- Entity observation boundaries update via LEAST/GREATEST. The evidence table
  points at exact original tweet, Telegram source+message, or chain transaction.
- No materialized graph inference or handle-based author merging is performed.

Local checks (Node 22+, no credentials):
  npm install --prefix packages/contracts --ignore-scripts --no-package-lock
  npm --prefix packages/contracts run build
  npm install --prefix intelligence --ignore-scripts --no-package-lock
  npm --prefix intelligence run check

GitHub CI starts a **temporary PostgreSQL** service and also verifies actual
migration/transaction/dedup behavior. It never accesses production databases.

Not yet included: source outbox wiring, durable ETL consumer/ACK, timeline,
checkpointed backfill or read API. No live X/TG/Solana credentials are needed.
