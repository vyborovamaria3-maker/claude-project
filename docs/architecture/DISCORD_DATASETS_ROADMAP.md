# Discord + historical Pump.fun data architecture (staged rollout, 2026-11-18)

## Scope and current PR

Start on main, independently of the unmerged Draft PR #215. Keep all live producer
flags disabled. Historical data, Discord bot collection, source-to-Intelligence event
contracts and cross-platform scoring are separate rollout gates.

**This PR implements foundation only**:
- Registry of candidate Coin-Meme, MELT, MemeChain, Trenches, Calls, Reddit datasets.
- Offline rights-gated CSV/JSONL/ZIP staging importer with file/row hashes, replay
  idempotency and honest first availability timestamps.
- Default-disabled official Discord bot source POC, message revisions, deletion
  tombstones, bounded REST backfill, allowlisted guild/channels, isolated PostgreSQL.
- Offline unit tests and CI for source normalization and permission gates.

None of these components is an operational production ingestion source yet.
Do not report historical/social coverage from this POC as complete.

## Planned independent follow-up PRs

DATA-02 — Source-specific schema adapters, streaming Parquet imports for MELT/Trenches/
Reddit, exact CSV/ZIP member mapping, row-level errors, persistent source/file
manifest with provenance + dataset version. Enforce legal rights, erasure, TTL and
data minimization before processing third-party user content. Verify actual source
contents and timestamps: catalog metadata alone is not proof.

DATA-03 — Historical Solana chain decoding and mint validation with per-program slot
coverage, reorg/finality semantics and supervised quality checks. Never verify
token identity from ticker, user ID, text similarity or base58 regex alone.
Avoid lookahead and survivorship bias; Raydium-migrated samples are not representative
of all Pump.fun launches.

DISCORD-02 — Robust Discord backfill/live convergence: separate Gateway events from REST,
per-channel cursors, retries and DLQ, partial-message updates/deletes, message
content authorization checks, threads, 429 backoff, bounded concurrency, permission
revocation, account-level erasure + retention schedules, encrypted and access-controlled
storage, provider policy audit. No selfbots or third-party unauthorized scraping.
Measure timestamp coverage and reconcile gaps using permitted API access only.

CONTRACT-01 — Add Discord source, stable guild/channel/user Snowflake IDs,
discord_message evidence, typed event schemas, source revision invalidation and V2
producers to packages/contracts and packages/event-outbox. Use additive migrations
for existing CHECK constraints, never rewrite applied migrations. All emitting
source events must be transactional with source writes, immutable event keys, source
created_at mapped to emittedAt, destination inbox SHA/identity collision checks
and bounded lease/ACK handling.

INTEL-01 — Wire Discord outbox to Intelligence destination through existing
ETL and supervisor, registry, timeline, verified token links, revisions and
retractions, backfill/recompute invalidation queue, per-source coverage windows.
Raw messages NEVER belong in the shared event envelope.

INTEL-02 — Versioned Discord feature schema (mentions 5m/1h, cross-channel spread,
copypasta, narrative velocity and source lags), independent scoring versions,
coverage-aware nulls, and research-only replay distinct from historically known-at
live evidence. Shadow evaluation first; no silent production score changes.

UI-01 — Per-token Discord provenance and coverage, operator source permission/
health status, import manifests and disabled/read-only controls. No source flagged
complete without proof.

## Merge gates

- Unit + integration tests for idempotency, lease expiry, event order, edits,
  deletions, schema compatibility and transactional ACK after destination commit.
- Offline synthetic data only in CI; no live Discord or paid API credentials.
- Enforced source rights and deletion/retention obligations, proof of bot/channel
  authorization, explicit data use purpose and audit trail.
- Verified Solana token identity, source coverage and replayable source hashes.
- No backdated knownAt: imported historical records first available today must
  not be treated as 2024 live observations. Explicitly label reconstructed research
  replay assumptions and exclude future-derived fields from early-token backtests.
- Shadow scoring / held-out backtests show measurable uplift before weight changes.
- Separate merge of hardening PR #215 and compatibility tests before sharing code.
