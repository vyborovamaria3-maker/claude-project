# Source transactional outbox — additive adapters (PR-4)

Per-source DB *building blocks* for at-least-once delivery. Use a **new**
additive migration per existing source DB to apply the appropriate DDL.
No source DB is modified by this package and no collectors are rewired.

## Critical wiring contract

1. First open the SOURCE transaction in X/TG/Postgres or blockchain/SQLite.
2. Write the primary row.
3. Call emitPostgres(existingTransactionClient, event) or
   emitSqlite(existingTransactionDb, event) BEFORE source COMMIT.
4. Commit source transaction atomically; never mark delivered here.
5. Claim a finite batch with an expiring lease. Commit claim.
6. Deliver to Intelligence with unique event identity and idempotent UPSERT.
7. Mark ACK **only after** committed destination; failed ACK is retried.
8. On error, apply bounded retry and dead-letter; lease expiry allows recovery.

- eventKey uniquely identifies an OBSERVATION/REVISION, not merely a tweet ID.
- PostgreSQL claims use SKIP LOCKED and short transactions; SQLite claims use
  BEGIN IMMEDIATE and short transactions. Do not hold a source transaction
  during network I/O.
- An event delivered successfully but not ACKed may be redelivered.
- Consumer must enforce UNIQUE(source,eventKind,eventKey).
- Backfill/replay, live schema migrations and actual consumer wiring are
  separate planned stages. This package alone does not deliver events.
- Use one local instance per source; do not share TG/X secrets with Intelligence.
- No provider calls; tests are isolated failure-path fixtures.

Run `npm install --prefix packages/event-outbox --ignore-scripts --no-package-lock`
and `npm --prefix packages/event-outbox run check`.
