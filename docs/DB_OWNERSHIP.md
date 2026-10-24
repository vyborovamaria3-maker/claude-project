# DB ownership — Intelligence 2.2

Each operational database remains the authority for its original observations.
The separate Intelligence PostgreSQL is the authority only for normalized,
versioned cross-platform analytics. No database is migrated or opened by this
document.

| DB | Owner | Owns | Intelligence access |
| --- | --- | --- | --- |
| X PostgreSQL | X Collector | Tweets, authors, revisions, X graph, tasks | Outbox claim/ACK; bounded read-only AI source adapter |
| Telegram PostgreSQL | TG Collector | Messages, edits, deletions, numeric peer IDs | Outbox claim/ACK; bounded read-only AI source adapter |
| Solana SQLite trade.db | Blockchain collector | Wallet observations and local trades | SQLite leased Outbox; no inferred PnL |
| Intelligence PostgreSQL | Intelligence | Inbox, Timeline, links, features, AI results, signals, backtests | Writer role for ETL, SELECT-only role for API |
| Legacy memecoin PostgreSQL | Memecoin app | Legacy analytics | Read-only compatibility, not a second cross-platform truth |
| Admin DB | Admin site | Operator configuration and audit | Administrative observability only |

## Non-negotiable boundaries

- Existing `intelligence_inbox` has PRIMARY KEY
  `(source_system,event_kind,event_key)`. Do not create a duplicate Inbox.
- Source commit -> destination commit -> source ACK. Replayed events must not
  change destination results.
- A ticker or username is not token identity proof. Identity mappings require
  source evidence, version and historical validity.
- An unverified wallet event is not a settled trade or authoritative PnL.
- The new Intelligence layer uses external HTTPS AI APIs with secret-managed
  API keys, not the legacy local Qwen 2.5 7B runtime.
- AI source-reader SQL is currently coupled to X/TG schemas; encrypted text
  snapshots are optional and NOT enabled until encryption, retention, purge and
  privacy controls are deployed.
- Browsers must never receive source DB URLs or the Intelligence API token.
  The loopback-only API requires a separately authenticated backend proxy.

## Backup and release checklist

1. Audit actual DB grants, migrations, checksum ledger and read-only roles.
2. Run disposable X, TG, SQLite and Intelligence integration tests.
3. Use PostgreSQL backups and test restoration in an isolated DB. Compare
   row counts and schemas with the source snapshot. Do not upload real user
   dumps to shared CI without explicit sanitization.
4. Use WAL-aware SQLite online backup, integrity verification and restore.
5. Validate queue replay, late edits, link invalidation, AI costs and covered
   versus unknown source windows before enabling producers.
6. Deploy each source and consumer via explicit opt-in; green CI does not prove
   any live source or provider integration.

### Request-only token reports (migration 016)

The optional authenticated token POST reads X/TG stores through read-only sessions and SQLite token_trades through a read-only handle. It writes only derived reports and usage to the separate Intelligence DB. No raw social text is copied there. Literal address matches are labeled as such, not promoted to verified mappings, and cached legacy trade rows do not prove settlement/PnL. Background ETL/AI flags are unnecessary and remain off in request-only deployment. Source coverage remains unknown when collection completeness is unproven.
