# X Collector → Intelligence source bridge

Additive migration 050_intelligence_source_outbox.sql is appended to the
X Collector's **explicit migration manifest**. Existing historical migration
files/numbering and the existing social reply/publishing outbox are untouched.

The new source producer is OFF by default. To opt in AFTER source migration,
backup and independent destination consumer deployment:
  X_INTELLIGENCE_OUTBOX_ENABLED=true

The opt-in emits an immutable tweet observation envelope INSIDE the existing
PG client transaction that writes tweets, metric observations, archival
history and search links. Duplicate observations keep the same eventKey and
cannot create duplicate source outbox rows. A page/lease failure rolls the
source data and Outbox event back together.

No login, XActions cookie, provider secret, full tweet text or raw response is
included in outbox payload. The only canonical entity emitted is a stable
numeric X author ID when available. Unknown authors are explicitly NOT
represented as an inferred ID from their mutable X handle; those historical
observations require bounded backfill after author ID resolution.

A search mint is not sufficient evidence that a specific tweet mentions
or promotes that mint: THIS BRIDGE DOES NOT AUTOMATICALLY ASSIGN A TOKEN
FROM QUERY CONTEXT. Later token-mint linking must use its own evidence
rules and revisioned event kind.

The consumer is a separate Intelligence process. None is started here.
The source collector remains on the user's laptop, with its existing
PostgreSQL task queue and browser/XActions sessions unchanged.

Pre-rollout checks:
- npm run migrate:audit; backup/migrate via native X migration ledger.
- npm run typecheck; npm test; npm run build and migration checks.
- Verify X author_id text provenance and unique observation timestamps.
- Deploy consumer, then explicitly enable opt-in; test a tiny bounded
  sample with no real user session/credentials printed.
- Backfill historical observations without overwriting archive history.
