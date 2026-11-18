# Discord + historical Pump.fun data architecture (staged rollout)

## Branch isolation and scope

- Draft PR #220 implements a permission-gated offline staging importer and
  default-off Discord research collector. It targets main, independently of
  Draft PR #215.
- Follow-up stacked hardening PR adds import manifests/run audits, fail-closed
  retention, source revision ordering, deletion tombstones, revoked-channel
  cleanup, and real PostgreSQL integration tests.
- The collectors remain default-off and are NOT production ready.

Historical datasets imported in 2026 are not evidence that the system had data
in 2024. Research replay must be explicitly synthetic, clearly labelled and
separate from operational first-known-at observations.

## Follow-up architecture and PR gates

DATA-02: inspect Coin-Meme and MemeChain actual CSV/ZIP layouts; implement strict
source-specific mappers and streaming Parquet for MELT/Trenches/Reddit with
bounded memory, versioned source hashes, per-file errors, retention/DSAR and
research-only license handling. No commercial import without proper permission.

DISCORD-02: authorized Gateway live + REST historical convergence, bounded
retries/DLQ, 429 rate limit handling, restart gap reconciliation, thread
discovery, permissions expiry and source revocation, content deletion/retention
including derived and backup datasets. Backfill cursor does not prove complete
coverage. No selfbots or scraping without platform authorization.

CONTRACT-01: typed Discord evidence and canonical guild/channel/user
Snowflake IDs, message observed/deleted/revision and verified mint link
invalidation. Source events committed transactionally with V2 envelopes and
read-only compatibility checks. SQL CHECK changes additive, never mutate
already-applied historical migrations.

INTEL-01: Discord source outbox to destination inbox, via existing ETL and
supervisor, registry/timeline, evidence verification and recomputation. ACK
only after destination commit. Replay, lease, collision and invalidation tests.
No raw user messages in shared Event Envelope.

INTEL-02: versioned cross-platform features and coverage-aware nulls, verified
Solana mints only, shadow scoring with held-out no-lookahead backtests, read-only
token evidence UI. No implicit changes to production ranking.

## Non-negotiable merge gates

- Rights review independently approved for the intended use; community
  consent is not an exemption from Discord Developer Policy.
- User content minimized, access controlled, deletable; data retention also
  enforced across backups and derived indexes before production use.
- Strict timestamp precision and knownAt; no future-derived feature leak.
- Backward compatibility with X, Telegram and blockchain producers tested.
- Compatibility with separate unmerged PR #215 reviewed before stacking into main.
- No external accounts, paid data downloads or production secrets in CI.
