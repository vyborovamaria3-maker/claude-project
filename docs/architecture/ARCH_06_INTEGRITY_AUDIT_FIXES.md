# ARCH-06 integrity audit — remediation and explicit boundaries

Draft PR stacked on #149 → #148 → #147. No production rollout, RPC requests, credential use or migrations were performed.

## Findings and remediations

1. **RAW revisions were overwritten.** `chain_seed_events` continues to hold only the current RAW, but every *new* revision is now copied to append-only `chain_seed_raw_revisions` inside the same SQLite transaction, including the previously current snapshot if still recoverable. A collision in archived bytes/hash fails closed. Historical revisions overwritten *before* upgrading **cannot be recovered**; gaps must be recorded operationally. This change does not magically make old RAW complete.
2. **Cross-wallet conflicting evidence.** Active Blockchain projection groups latest known wallet revisions per signature. If any wallet has unsupported status or wallets disagree on mint, slot or occurrence time, **the transaction has no active mint**. Matching wallet viewpoints yield one active token evidence record. Inconsistencies remain in immutable revision history, not complete trade/PnL.
3. **As-of leakage.** `knownAt` now checks both source observation and **actual destination ingestion** for Blockchain revisions, Token Timeline and active X/TG Token Links (including invalidations). For existing data, historical `knownAt` queries may correctly return fewer records than before. If a backtest needs signal availability, actual signal publication still needs its own timestamp.
4. **Missing migration gate.** Before a Blockchain source can claim events, ETL CLI and supervisor check for migration `005_blockchain_swap_evidence_revisions.sql`. The read-only Intelligence API likewise checks migration 005 before startup.
5. **RPC status contradiction.** The offline verifier rejects mismatch or absence of legacy `status: {Ok:null}` and `err:null`, as well as non-finalized confirmations. It still cannot trust unattested bytes provided by a caller.
6. **Trusted RPC provenance remains BLOCKED.** These are *offline synthetic/opaque RPC receipts*. No live, independently authenticated endpoint binding, genesis hash attestation, historical at-slot mint state, cryptographic inclusion/finality proof, or quorum across providers is implemented. This code must not emit `mint_verified_on_chain` or `trade_executed`.
7. **No user-facing active evidence route.** Added opt-in, locally authenticated read-only route `GET /api/intelligence/v1/tokens/{solana:mint}/swap-evidence?occurredBefore=...&knownAt=...`. Responses disclose only a bounded, conservative `provider_parsed_wallet_swap` chain-transaction identity, status `not_independently_verified`, unknown trade completeness, never amounts, raw hashes, wallet names, PnL or provider payloads. This route **does not publish a verified trade tape**.

## Acceptance and rollout gates

- Offline SQLite source regression: archive every changed RAW revision, force rollback, reject duplicate conflicts, default feature OFF.
- Temporary PostgreSQL isolated schemas: out-of-order revisions, verified→unsupported corrections, conflicting wallets, source observation vs destination receipt time, token links and timeline late delivery, migration 005 readiness.
- Offline RPC fixtures: initialized SPL Token classic/Token-2022 layouts, exact request matching, slot/finality consistency, corrupted/conflicting statuses.
- Read-only HTTP: auth, strict query bounds, no payload, no API claims of full history or finalized PnL, migration 005 preflight.
- Latest-head CI plus independent review **before** merge. Worktree changes alone do not validate real PostgreSQL/SQLite backups.
- No live collection or RPC verification until reviewed WAL-safe backup/restore, explicit approved spending budget, audited provenance, and observed reorg/unknown correction policies.

## Key semantic boundaries

`source observedAt` ≠ `destination ingestedAt` ≠ `when a signal was published`.

`provider parsed swap evidence` ≠ `SPL Mint verified at swap slot` ≠ `finalized trade tape` ≠ `verified PnL`.

Existing archived historic timeline remains historical and can show superseded revisions. Only the new **active** query excludes invalidated or conflicting claims, and only among the sources visible by `knownAt`.


## Codex continuation � 2026-10-20

Review of current #150 HEAD 32bee1b0 and its stacked base (#149 -> #148 -> #147): all ten original workflows / fifteen jobs completed successfully. Separate code review covered RAW persistence, revision agreement, source/destination time filters, preclaim 005 readiness, receipt consistency and the read-only API allowlist/auth/session configuration.

Confirmed follow-up defects and fixes:
- Available legacy RAW bytes with a NULL pre-upgrade hash were silently skipped before replacement. Archive the original gzip with a derived SHA-256 and original clocks, including unchanged rows encountered after upgrade. Never reconstruct overwritten revisions.
- RAW history had no database enforcement against UPDATE/DELETE or conflicting INSERT OR REPLACE. Add additive triggers and compare archived slot/time metadata as well as bytes/hash. Administrative DDL can still remove these protections; this is not tamper-proof storage.
- Offline RPC envelopes could contain both a result and an error. Reject those contradictory envelopes and explicitly return `provenance: unverified_offline_receipts` plus unauthenticated-origin/cluster limitations. Request matching remains structural, not authenticated acquisition.

Synthetic in-memory SQLite regressions cover idempotent upgrade, legacy NULL/hash rows, unchanged-row archival, rollback and mutation/replacement refusal. PostgreSQL regression adds conflicting supported wallet mint/slot/occurrence and subsequent agreement restoration. Local Intelligence strict typecheck/build and 54 tests passed; 13 PostgreSQL tests require the disposable CI service. Targeted source persistence/outbox and RPC suites passed. Full local blockchain suite stopped at missing `next/server` in the minimal dependency installation; the full suite must pass in latest-head CI.

Unchanged blockers: authenticated endpoint/cluster/request-response provenance, historical mint state, independently established finality, complete trade decoding/history and authoritative PnL. No real database, secret or RPC used; no main changes or merge.

RPC provenance follow-up: docs/architecture/ARCH_06_RPC_PROVENANCE.md specifies an offline collector-signed package verifier and an atomic challenge-consumption acceptance adapter. It authenticates only the configured witness report. Real endpoint acquisition, durable challenge storage and historical/finality/PnL gates remain blocked; no existing API confidence changes.

Challenge persistence follow-up: the explicit dedicated SQLite adapter now implements durable issuance and conditional atomic consumption. Temporary synthetic tests cover process restarts, lost acknowledgement after commit, concurrent connections and replay refusal. Production acquisition/key custody/store deployment and backup rollback policy remain separate gates; this still does not prove finality, complete trades or PnL.
