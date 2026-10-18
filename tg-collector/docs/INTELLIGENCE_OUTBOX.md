# TG Collector → Intelligence (opt-in producer)

This is **source-side** transactional emission, NOT a running ETL consumer.

- Migration `015_intelligence_outbox.sql` adds PG `outbox_events` with lease and
  dead-letter fields. Apply using the existing TG `npm run migrate` (which
  computes SQL checksums). Never edit previously applied SQL migrations.
- Producer is off by default. Enable only with
  `TG_INTELLIGENCE_OUTBOX_ENABLED=true` AFTER verifying the local source DB
  migration, backups, and installation of an Intelligence destination/consumer.
- `persistMessage(tx,...)` runs inside the existing page transaction and
  inserts a versioned event before COMMIT; if INSERT fails, source transaction
  rolls back. Distinct changes to text/edit timestamp/metrics produce unique
  source revision hashes. Exact repeats have `ON CONFLICT DO NOTHING`.
- `markMessageDeleted(tx,...)` writes a separate, source-evidenced soft-delete
  event only after a changed row; evidence from historical revisions remains.
- Evidence identity uses the **stable numeric Telegram channel peer_id**, not
  the local BIGSERIAL `tg_sources.id` or a mutable username. The engine
  populates peer_id from GramJS before page collection.
- When `peer_id` is absent or nonnumeric, opted-in persistence FAILS CLOSED
  and the page rolls back so no evidence is lost behind a bogus identity.
  Existing prior messages need explicit source-resolution and checkpointed
  backfill; do not silently invent a peer ID.
- For raw TG address strings and $tickers the producer exports **source only**.
  They are not automatically verified token mints. A later evidence-driven
  identity resolver may attach canonical token IDs.
- Outbox payloads contain event/evidence references, observation times and
  revision identity. No message body, GramJS session, proxy, API key or
  unverified token attribution is exported.
- The consuming Intelligence batch has independent ACK/retry processing; it
  must be started separately. No cross-DB exactly-once guarantee is implied.

Production gate: do not turn this on until a disposable-PG integration test,
source migration backup, recovery check and destination ETL are verified.
