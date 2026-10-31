# PR_STATUS — GitHub PR inventory

## Current snapshot — 2026-10-31

Observed `main` SHA: `9f4a7e88afa80774633ee4a43221a621fe5f1922`. GitHub branch metadata reports `main.protected=false`. Passing CI is not a substitute for human review or branch governance; administrator action remains tracked in [issue #170](https://github.com/vyborovamaria3-maker/claude-project/issues/170).

Seven open PRs are currently returned by GitHub:

| PR | Title | State | Latest observed head |
| --- | --- | --- | --- |
| [#207](https://github.com/vyborovamaria3-maker/claude-project/pull/207) | fix(event-outbox): use PostgreSQL clock for claims and retries | OPEN | `4a9d0362f855b8242ccebfe64988e45b1dc1769a` |
| [#206](https://github.com/vyborovamaria3-maker/claude-project/pull/206) | feat(intelligence): add read-only supervisor health metrics | OPEN | `d2b22ea369042952e6d4c35d1a9732f7ace6b05a` |
| [#205](https://github.com/vyborovamaria3-maker/claude-project/pull/205) | docs(architecture): refresh whole-repository baseline and technical debt | OPEN | This documentation branch |
| [#204](https://github.com/vyborovamaria3-maker/claude-project/pull/204) | fix(admin): relocate collector workspaces exclusively to standalone Control Center | OPEN DRAFT | `2f4bf7e09be402230307073de8754cc389f2a9db` |
| [#203](https://github.com/vyborovamaria3-maker/claude-project/pull/203) | UI: единая вкладка Analysis с графиком и подробной панелью | OPEN | `1ba1f6bf561a082c59d924d440891c1f9924cb00` |
| [#202](https://github.com/vyborovamaria3-maker/claude-project/pull/202) | feat: Hood Hunt-style evidence-first analytics, DEV setups and target review | OPEN DRAFT | `40131ff79600c7767dfec7f262d67058724ac046` |
| [#195](https://github.com/vyborovamaria3-maker/claude-project/pull/195) | feat: split FOMO pressure and quality metrics | OPEN DRAFT | `fbdbf4ddd1590982fd71142784acbd9a32e1f68b` |

- **PR #207 — Outbox clock correctness.** Open, unmerged, targets `main`, 7 files. On the latest observed head, Transactional outbox adapters passed **16/16**, including real PostgreSQL 16 tests for claim and retry behavior under a simulated host clock one minute behind DB time. Intelligence foundation passed **247/247**; Intelligence CI, Native social token-link CI and Repository hygiene passed; Security Lock Refresh was skipped because no lockfile changes were needed. GitHub reports mergeable. No human review submission exists.
- **PR #206 — supervisor health metrics.** Open, unmerged, targets `main`, 5 files. Follow-up audit found and corrected PostgreSQL health metrics that had used the supervisor host clock. Latest head `d2b22ea369042952e6d4c35d1a9732f7ace6b05a` now uses one DB-side `statement_timestamp()` observation for queue predicates and age calculations, returns `measuredAt`, preserves deterministic overrides, and includes a real PostgreSQL 16 clock-skew/alert-boundary regression. Latest Intelligence foundation passed **252/252**; Intelligence CI, Native social token-link CI and Repository hygiene passed; Security Lock Refresh was skipped. GitHub reports mergeable. No human review submission exists. Alerts remain structured stdout records, not an external notification service.
- **PR #205 — architecture documentation.** Open and unmerged, 19 files. This inventory is itself part of #205, so its own head SHA and commit count are intentionally omitted to avoid embedding a self-stale value. The pre-refresh head `a4b48f7465fa495b77ef33607f91ebb6eee982ab` had 5 successful checks and 1 skipped check; re-read CI for the new documentation commit before any integration. No human review submission exists.
- **PR #204 — Admin Control Center migration.** Open draft, 81 files, 16 commits. Last observed checks: 30 successful, 1 skipped, 0 failed/pending. No human review submission exists. It overlaps #203 in nine paths and remains a draft; no merge or rollout.
- **PR #203 — unified Analysis UI.** Open, unmerged, 43 files, 128 commits. Latest observed head `1ba1f6bf561a082c59d924d440891c1f9924cb00` had 33 successful checks and 1 skipped, 0 failed/pending. GitHub reports mergeable, but no human review submission exists. The PR is broader than its UI title and also changes Admin links, Intelligence API/AI gateway and CI.
- **PR #202 — Hood Hunt analytics foundation.** Open draft, targets `main`, 18 files. Latest observed head had 10 successful workflows and 1 skipped; no human review submission exists. The current filename audit found no direct overlap with #207, #206, #205, #203, #204 or #195. Re-check its base/head and mergeability before future integration.
- **PR #195 — FOMO pressure/quality.** Open draft, 23 files, 60 commits. GitHub reports it is not mergeable (`mergeable=false`); no workflow runs were returned for its current head and no human review submission exists. Do not integrate until its dirty state and overlapping files are reconciled.

### Path-overlap and integration order

| PR pair | Shared paths | Integration note |
| --- | ---: | --- |
| #207 / #206 | 1 | Both edit `intelligence/scripts/etl-connections.mjs`. Current hunks are separate: #207 changes the PostgreSQL source failure adapter; #206 changes the read-only health query. Re-check after #207 is integrated. |
| #205 / #206 | 1 | Both edit `intelligence/README.md` in different sections; reconcile the combined operator documentation. |
| #203 / #204 | 9 | Shared Admin navigation, styles, package and context files; do not merge independently without a reviewed combined diff. |
| #203 / #195 | 5 | Includes `SocialIntelligencePanel.tsx`, `package.json` and analysis regressions; reconcile FOMO capture/UI behavior with unified Analysis. |
| #204 / #195 | 3 | Shared docs and package metadata; reconcile after the primary UI overlap. |
| #202 / other listed PRs | 0 | No direct changed-path overlap found in the current filename audit. |

Suggested sequence, subject to human review: **#207 → reconcile/integrate #206 → refresh #205 documentation**. The #206 PostgreSQL clock-skew correction is already committed and CI-green, but its integration with #207 still needs a post-merge-base check. Separately resolve #203/#204/#195 overlaps before considering #203. Keep #202 as an independent draft until its product scope and review are ready.

### Issue #174 — delivery and recovery acceptance

Issue [#174](https://github.com/vyborovamaria3-maker/claude-project/issues/174) remains **OPEN**. #207 improves DB-clock correctness; #206 adds read-only queue/progress/retry/DLQ/schema-skew metrics and structured alert records. Neither PR proves production operation or closes the operational acceptance. Still outstanding: named owner and start/stop procedure per source/destination, approved external alert delivery, supervised restart/rollout/rollback, disposable end-to-end source/destination failure-and-recovery rehearsal, and verified backup/restore. No production DB, collector, credentials, external alert sink or deployment was accessed.

Human review/approval remains outstanding for the active PR set. GitHub returned no review submissions for #195 and #202–#207. Passing CI and `mergeable=true` are not permission to merge. Always re-read current head SHA, mergeability, reviews and checks on GitHub immediately before acting.

## Historical inventory snapshot — 2026-10-24


Point-in-time snapshot of the public [GitHub PR listing](https://github.com/vyborovamaria3-maker/claude-project/pulls). **GitHub is authoritative** for current status, CI, review and merge base; this file can become stale after every update.

- Retrieved **173 unique PRs** using paged GitHub API enumeration: **12 open**, **125 merged**, **36 closed without merge**.
- [#165](https://github.com/vyborovamaria3-maker/claude-project/pull/165) is **MERGED to main** as `0bfd1c71c438d2f32a93652f4b6a2670c38d7b9b`, incorporating [#184](https://github.com/vyborovamaria3-maker/claude-project/pull/184), a real isolated PG/SQLite regression against *synthetic preverified* evidence. **Not a live release.**
- [#166](https://github.com/vyborovamaria3-maker/claude-project/pull/166) remains a **draft targeting the original #165 feature branch** rather than `main`; after merging #165, do not blindly retarget without checking delta/rebase/dependencies. [#167](https://github.com/vyborovamaria3-maker/claude-project/pull/167) remains a separate draft against `main` with overlapping AI/analytics. Reconcile designs under [#176](https://github.com/vyborovamaria3-maker/claude-project/issues/176).
- [#183](https://github.com/vyborovamaria3-maker/claude-project/pull/183) was **closed unmerged** after its JSONB regression exposed a contract bug already fixed by #165. [#184](https://github.com/vyborovamaria3-maker/claude-project/pull/184) superseded it and merged into #165.
- No main protection/admin rules, real X/TG/RPC deployment or backup restore is inferred from PR status.

## Open PRs (12)

| PR | Title | Target branch | State | Last update (UTC) |
| --- | --- | --- | --- | --- |
| [#185](https://github.com/vyborovamaria3-maker/claude-project/pull/185) | docs: reconcile native mint verification and CI status after #165 merge | `main` | OPEN | 2026-10-24 |
| [#167](https://github.com/vyborovamaria3-maker/claude-project/pull/167) | feat(intelligence): cross-platform analytics and API AI gateway | `main` | OPEN DRAFT | 2026-10-24 |
| [#166](https://github.com/vyborovamaria3-maker/claude-project/pull/166) | feat(ai): governed multi-source read model for external AI API | `feature/canonical-token-native-adapter-20261022` | OPEN DRAFT | 2026-10-22 |
| [#162](https://github.com/vyborovamaria3-maker/claude-project/pull/162) | Dataset: import Solana memecoin research trades into isolated SQLite tables | `feat/blockchain-finality-witness-quorum-20261022` | OPEN DRAFT | 2026-10-22 |
| [#161](https://github.com/vyborovamaria3-maker/claude-project/pull/161) | Integrate public Telegram datasets into TG Collector | `main` | OPEN | 2026-10-22 |
| [#159](https://github.com/vyborovamaria3-maker/claude-project/pull/159) | Blockchain: signed two-witness finality reports with atomic nonce replay protection | `feat/blockchain-durable-finality-watch-20261022` | OPEN DRAFT | 2026-10-22 |
| [#158](https://github.com/vyborovamaria3-maker/claude-project/pull/158) | Blockchain: hardened durable RAW watcher, validated SQLite journal and manual invalidation queue | `feat/blockchain-finality-coverage-audit-20261022` | OPEN DRAFT | 2026-10-22 |
| [#157](https://github.com/vyborovamaria3-maker/claude-project/pull/157) | Blockchain: revision-bound finality recheck and historical coverage audit | `feat/blockchain-inventory-lifecycle-20261021` | OPEN DRAFT | 2026-10-22 |
| [#156](https://github.com/vyborovamaria3-maker/claude-project/pull/156) | Blockchain: owner observation history, lifecycle evidence and fail-closed PnL gates | `feat/blockchain-inventory-reconciliation-20261021` | OPEN DRAFT | 2026-10-21 |
| [#155](https://github.com/vyborovamaria3-maker/claude-project/pull/155) | Blockchain: exact SPL inventory reconciliation and RAW-revision-safe movement persistence | `feat/blockchain-evidence-fee-audit-20261021` | OPEN DRAFT | 2026-10-21 |
| [#153](https://github.com/vyborovamaria3-maker/claude-project/pull/153) | Blockchain: exact fee evidence, native balance checks, inventory quality and DEX adversarial tests | `main` | OPEN DRAFT | 2026-10-21 |
| [#151](https://github.com/vyborovamaria3-maker/claude-project/pull/151) | TG Collector: quarantine repetitive VIP milestone spam channels after 120-post preview | `audit/arch-01-03-integration-20261020` | OPEN DRAFT | 2026-10-20 |

## Closed / merged PRs (161)

| PR | Title | Target branch | State | Last update (UTC) |
| --- | --- | --- | --- | --- |
| [#184](https://github.com/vyborovamaria3-maker/claude-project/pull/184) | test(intelligence): exercise real outbox JSONB, ACK rollback and cross-source evidence (#173) | `feature/canonical-token-native-adapter-20261022` | MERGED | 2026-10-24 |
| [#183](https://github.com/vyborovamaria3-maker/claude-project/pull/183) | test(intelligence): verify cross-source evidence rollback, retraction and replay (#173) | `main` | CLOSED UNMERGED | 2026-10-24 |
| [#182](https://github.com/vyborovamaria3-maker/claude-project/pull/182) | docs: refresh architecture evidence, test register and ADRs | `main` | MERGED | 2026-10-24 |
| [#181](https://github.com/vyborovamaria3-maker/claude-project/pull/181) | Docs/platform readiness 20261024 | `main` | MERGED | 2026-10-24 |
| [#169](https://github.com/vyborovamaria3-maker/claude-project/pull/169) | fix(security): patch OpenTelemetry, ip-address and Zod | `main` | MERGED | 2026-10-24 |
| [#168](https://github.com/vyborovamaria3-maker/claude-project/pull/168) | fix: repair Solana dependency security audits | `main` | MERGED | 2026-10-23 |
| [#165](https://github.com/vyborovamaria3-maker/claude-project/pull/165) | feat(contracts): normalize native TG/X/chain mint identifiers | `main` | MERGED | 2026-10-24 |
| [#164](https://github.com/vyborovamaria3-maker/claude-project/pull/164) | docs(audit): TG Collector sprint 0 data contracts, gaps and test register | `main` | MERGED | 2026-10-24 |
| [#163](https://github.com/vyborovamaria3-maker/claude-project/pull/163) | Integrate Telegram datasets into collector queue | `main` | MERGED | 2026-10-22 |
| [#160](https://github.com/vyborovamaria3-maker/claude-project/pull/160) | Integrate public Telegram datasets into TG Collector | `main` | CLOSED UNMERGED | 2026-10-22 |
| [#154](https://github.com/vyborovamaria3-maker/claude-project/pull/154) | test: remove refactor-hostile checks and test observable behavior | `main` | MERGED | 2026-10-24 |
| [#152](https://github.com/vyborovamaria3-maker/claude-project/pull/152) | fix: prove Pump wallet attribution, settlement and creator discovery | `main` | MERGED | 2026-10-23 |
| [#150](https://github.com/vyborovamaria3-maker/claude-project/pull/150) | fix(blockchain): ARCH-06 evidence integrity and fail-closed readiness | `feat/arch-06b2-offline-solana-proof-gate-20261020` | MERGED | 2026-10-20 |
| [#149](https://github.com/vyborovamaria3-maker/claude-project/pull/149) | feat(blockchain): ARCH-06b2a offline SPL Mint and finalized-status proof gate | `feat/arch-06b-revision-aware-swap-evidence-20261020` | MERGED | 2026-10-20 |
| [#148](https://github.com/vyborovamaria3-maker/claude-project/pull/148) | feat(blockchain): ARCH-06b1 revision-aware swap evidence states | `feat/arch-06a-blockchain-token-swap-evidence-20261020` | MERGED | 2026-10-20 |
| [#147](https://github.com/vyborovamaria3-maker/claude-project/pull/147) | feat(blockchain): ARCH-06a conservative mint-attributed swap evidence to Intelligence | `fix/arch-11-audit-p0-p1-integrity-20261020` | MERGED | 2026-10-20 |
| [#146](https://github.com/vyborovamaria3-maker/claude-project/pull/146) | fix(deploy): ARCH-02 pinned SSH, atomic backups and isolated restore rehearsal | `audit/arch-01-03-integration-20261020` | MERGED | 2026-10-20 |
| [#145](https://github.com/vyborovamaria3-maker/claude-project/pull/145) | fix(intelligence): audit P0/P1 mint proof, source retractions and delivery integrity | `feat/arch-11-potapoff-token-intelligence-ui-20261020` | MERGED | 2026-10-20 |
| [#144](https://github.com/vyborovamaria3-maker/claude-project/pull/144) | feat(potapoff): ARCH-11 authenticated Token Intelligence UI and localhost-only proxy | `feat/arch-10-readonly-token-intelligence-api-20261020` | MERGED | 2026-10-20 |
| [#143](https://github.com/vyborovamaria3-maker/claude-project/pull/143) | feat(intelligence): ARCH-10 secure localhost read-only Token Intelligence API v1 | `fix/arch-09-tg-signed-peer-parity-20261020` | MERGED | 2026-10-20 |
| [#142](https://github.com/vyborovamaria3-maker/claude-project/pull/142) | feat(intelligence): three-model offline X/TG sentiment enrichment | `audit/arch-01-03-integration-20261020` | MERGED | 2026-10-20 |
| [#141](https://github.com/vyborovamaria3-maker/claude-project/pull/141) | fix(tg): canonical signed peer IDs in outbox, history and quality metrics | `feat/arch-09-data-quality-report-20261020` | MERGED | 2026-10-20 |
| [#140](https://github.com/vyborovamaria3-maker/claude-project/pull/140) | feat(intelligence): ARCH-09 read-only source coverage and data-quality dashboard | `feat/arch-08-source-evidence-backfill-20261020` | MERGED | 2026-10-20 |
| [#139](https://github.com/vyborovamaria3-maker/claude-project/pull/139) | feat(intelligence): ARCH-08 bounded historical X/TG/Blockchain source-outbox backfill | `feat/arch-05b-x-mint-rpc-verification-20261020` | MERGED | 2026-10-20 |
| [#138](https://github.com/vyborovamaria3-maker/claude-project/pull/138) | fix(tg-collector): complete history scanning and preserve Telegram evidence | `audit/arch-01-03-integration-20261020` | MERGED | 2026-10-20 |
| [#137](https://github.com/vyborovamaria3-maker/claude-project/pull/137) | feat(x): ARCH-05b bounded Alchemy SPL mint proof and source edit tombstones | `feat/arch-07a-token-links-invalidation-20261020` | MERGED | 2026-10-20 |
| [#136](https://github.com/vyborovamaria3-maker/claude-project/pull/136) | feat(intelligence): ARCH-07a retractable as-of token link evidence | `feat/arch-05-verified-token-links-20261020` | MERGED | 2026-10-20 |
| [#135](https://github.com/vyborovamaria3-maker/claude-project/pull/135) | feat(architecture): ARCH-05a verified X/TG mint evidence contracts and source adapters | `feat/arch-04-local-etl-supervisor-20261020` | MERGED | 2026-10-20 |
| [#134](https://github.com/vyborovamaria3-maker/claude-project/pull/134) | feat(intelligence): ARCH-04 local ETL supervisor and fenced lease renewal | `audit/arch-01-03-integration-20261020` | MERGED | 2026-10-20 |
| [#133](https://github.com/vyborovamaria3-maker/claude-project/pull/133) | Integrate ARCH-01–11, collector repairs and evidence integrity | `main` | MERGED | 2026-10-20 |
| [#132](https://github.com/vyborovamaria3-maker/claude-project/pull/132) | Expand no-Premium token discovery with Telegram-verified external sources | `main` | MERGED | 2026-10-19 |
| [#131](https://github.com/vyborovamaria3-maker/claude-project/pull/131) | Discover token messages and collect full public channel/discussion history | `main` | MERGED | 2026-10-19 |
| [#130](https://github.com/vyborovamaria3-maker/claude-project/pull/130) | Fix Pump.fun 403 with verified historical-cap fallback | `main` | MERGED | 2026-10-19 |
| [#129](https://github.com/vyborovamaria3-maker/claude-project/pull/129) | Filter Telegram discovery by Pump.fun mint, ticker and ATH capitalization | `main` | MERGED | 2026-10-19 |
| [#128](https://github.com/vyborovamaria3-maker/claude-project/pull/128) | Discover Telegram crypto sources using Twitter keywords | `main` | MERGED | 2026-10-19 |
| [#127](https://github.com/vyborovamaria3-maker/claude-project/pull/127) | Harden X autopost retries, deduplication, and reconciliation | `audit/arch-01-03-integration-20261020` | MERGED | 2026-10-20 |
| [#126](https://github.com/vyborovamaria3-maker/claude-project/pull/126) | Fix multi-owner Pump swap attribution from saved transaction evidence | `audit/arch-01-03-integration-20261020` | MERGED | 2026-10-20 |
| [#125](https://github.com/vyborovamaria3-maker/claude-project/pull/125) | docs: complete Codex integration map for X/TG/Blockchain and local Intelligence ETL | `main` | MERGED | 2026-10-18 |
| [#124](https://github.com/vyborovamaria3-maker/claude-project/pull/124) | feat(intelligence): explicit local ETL CLI and real X/TG/SQLite delivery tests | `main` | MERGED | 2026-10-18 |
| [#123](https://github.com/vyborovamaria3-maker/claude-project/pull/123) | feat(blockchain): lease-fenced SQLite source outbox for raw wallet evidence | `main` | MERGED | 2026-10-18 |
| [#122](https://github.com/vyborovamaria3-maker/claude-project/pull/122) | feat(x-collector): opt-in atomic tweet observation Outbox for local collector | `main` | MERGED | 2026-10-18 |
| [#121](https://github.com/vyborovamaria3-maker/claude-project/pull/121) | feat(tg): atomic outbox for source message revisions and deletion | `main` | MERGED | 2026-10-18 |
| [#120](https://github.com/vyborovamaria3-maker/claude-project/pull/120) | fix(intelligence): validate on-chain evidence and detect event identity collisions | `docs/codex-intelligence-handoff-20261018` | CLOSED UNMERGED | 2026-10-18 |
| [#119](https://github.com/vyborovamaria3-maker/claude-project/pull/119) | docs: Codex rollout handoff and source event contract | `test/outbox-real-database-contracts-20261018` | CLOSED UNMERGED | 2026-10-18 |
| [#118](https://github.com/vyborovamaria3-maker/claude-project/pull/118) | test(outbox): exercise real PostgreSQL and SQLite claim/ACK/retry | `feat/intelligence-token-features-20261018` | CLOSED UNMERGED | 2026-10-18 |
| [#117](https://github.com/vyborovamaria3-maker/claude-project/pull/117) | feat(intelligence): immutable token feature store v1 (foundation) | `feat/intelligence-etl-delivery-20261018` | CLOSED UNMERGED | 2026-10-18 |
| [#116](https://github.com/vyborovamaria3-maker/claude-project/pull/116) | feat(intelligence): bounded outbox delivery processor (ETL foundation) | `feat/intelligence-timeline-20261018` | CLOSED UNMERGED | 2026-10-18 |
| [#115](https://github.com/vyborovamaria3-maker/claude-project/pull/115) | feat(intelligence): source-backed time-travel timeline (PR-6) | `feat/intelligence-registry-20261018` | CLOSED UNMERGED | 2026-10-18 |
| [#114](https://github.com/vyborovamaria3-maker/claude-project/pull/114) | feat(intelligence): destination entity registry and source evidence (PR-5) | `feat/transactional-outbox-adapters-20261018` | CLOSED UNMERGED | 2026-10-18 |
| [#113](https://github.com/vyborovamaria3-maker/claude-project/pull/113) | feat(outbox): transactional PostgreSQL and SQLite event adapters (PR-4) | `feat/shared-utilities-20261018` | CLOSED UNMERGED | 2026-10-18 |
| [#112](https://github.com/vyborovamaria3-maker/claude-project/pull/112) | feat(shared-utils): retry, AES-GCM, log redaction and local quotas (PR-3) | `feat/db-migration-contracts-20261018` | CLOSED UNMERGED | 2026-10-18 |
| [#111](https://github.com/vyborovamaria3-maker/claude-project/pull/111) | feat(db-common): PostgreSQL/SQLite checksum migration adapters (PR-2) | `feat/shared-contracts-foundation-20261018` | CLOSED UNMERGED | 2026-10-18 |
| [#110](https://github.com/vyborovamaria3-maker/claude-project/pull/110) | feat: establish shared canonical ID and evidence contracts (PR-1) | `main` | MERGED | 2026-10-18 |
| [#109](https://github.com/vyborovamaria3-maker/claude-project/pull/109) | Final offline Alchemy inventory regression | `fix/blockchain-collection-throughput-20261014` | CLOSED UNMERGED | 2026-10-17 |
| [#108](https://github.com/vyborovamaria3-maker/claude-project/pull/108) | Offline validation — inventory decoder | `fix/blockchain-collection-throughput-20261014` | CLOSED UNMERGED | 2026-10-17 |
| [#107](https://github.com/vyborovamaria3-maker/claude-project/pull/107) | Final offline validation for Alchemy inventory decoder | `fix/blockchain-collection-throughput-20261014` | CLOSED UNMERGED | 2026-10-17 |
| [#106](https://github.com/vyborovamaria3-maker/claude-project/pull/106) | Validate Alchemy inventory decoder on latest collector | `fix/blockchain-collection-throughput-20261014` | CLOSED UNMERGED | 2026-10-17 |
| [#105](https://github.com/vyborovamaria3-maker/claude-project/pull/105) | Validate Alchemy inventory decoder and reconciliation | `fix/blockchain-collection-throughput-20261014` | CLOSED UNMERGED | 2026-10-17 |
| [#104](https://github.com/vyborovamaria3-maker/claude-project/pull/104) | Validate final Alchemy collector regressions | `fix/blockchain-collection-throughput-20261014` | CLOSED UNMERGED | 2026-10-17 |
| [#103](https://github.com/vyborovamaria3-maker/claude-project/pull/103) | Validate final Alchemy-first collector revision | `fix/blockchain-collection-throughput-20261014` | CLOSED UNMERGED | 2026-10-17 |
| [#102](https://github.com/vyborovamaria3-maker/claude-project/pull/102) | Validate latest Alchemy-first collector fixes | `fix/blockchain-collection-throughput-20261014` | CLOSED UNMERGED | 2026-10-17 |
| [#101](https://github.com/vyborovamaria3-maker/claude-project/pull/101) | Validate Alchemy-first blockchain collector | `fix/blockchain-collection-throughput-20261014` | CLOSED UNMERGED | 2026-10-17 |
| [#100](https://github.com/vyborovamaria3-maker/claude-project/pull/100) | Add raw retention metadata and stable author IDs | `main` | MERGED | 2026-10-18 |
| [#99](https://github.com/vyborovamaria3-maker/claude-project/pull/99) | Add signal-quality marts and out-of-sample evaluation | `main` | MERGED | 2026-10-18 |
| [#98](https://github.com/vyborovamaria3-maker/claude-project/pull/98) | Add confidence-aware tweet-to-token linker | `main` | MERGED | 2026-10-18 |
| [#97](https://github.com/vyborovamaria3-maker/claude-project/pull/97) | Preserve unknown X tweet metrics as NULL | `main` | MERGED | 2026-10-17 |
| [#96](https://github.com/vyborovamaria3-maker/claude-project/pull/96) | Preserve raw XActions responses for replay | `main` | MERGED | 2026-10-17 |
| [#95](https://github.com/vyborovamaria3-maker/claude-project/pull/95) | Harden X Collector migration checksum drift detection | `main` | CLOSED UNMERGED | 2026-10-17 |
| [#94](https://github.com/vyborovamaria3-maker/claude-project/pull/94) | Secure collector RPC dependencies and detect migration checksum drift | `main` | MERGED | 2026-10-17 |
| [#93](https://github.com/vyborovamaria3-maker/claude-project/pull/93) | docs(x-collector): tighten legacy and migration boundaries | `main` | MERGED | 2026-10-16 |
| [#92](https://github.com/vyborovamaria3-maker/claude-project/pull/92) | test/docs(x-collector): stabilize migration manifest checks | `main` | MERGED | 2026-10-16 |
| [#91](https://github.com/vyborovamaria3-maker/claude-project/pull/91) | ci(x-collector): make unused-file audit blocking | `main` | MERGED | 2026-10-16 |
| [#90](https://github.com/vyborovamaria3-maker/claude-project/pull/90) | refactor(x-collector): remove unreachable shutdown helper | `main` | MERGED | 2026-10-16 |
| [#89](https://github.com/vyborovamaria3-maker/claude-project/pull/89) | docs(x-collector): define lib/trade ownership boundary | `main` | MERGED | 2026-10-16 |
| [#88](https://github.com/vyborovamaria3-maker/claude-project/pull/88) | chore(x-collector): organize manual test scripts | `main` | MERGED | 2026-10-16 |
| [#87](https://github.com/vyborovamaria3-maker/claude-project/pull/87) | chore(x-collector): organize manual test scripts | `main` | CLOSED UNMERGED | 2026-10-16 |
| [#86](https://github.com/vyborovamaria3-maker/claude-project/pull/86) | docs(x-collector): archive historical integration reports | `main` | MERGED | 2026-10-16 |
| [#85](https://github.com/vyborovamaria3-maker/claude-project/pull/85) | refactor(intelligence): remove 145 unreachable legacy modules | `main` | MERGED | 2026-10-16 |
| [#84](https://github.com/vyborovamaria3-maker/claude-project/pull/84) | chore(x-collector): organize manual test scripts | `main` | CLOSED UNMERGED | 2026-10-16 |
| [#83](https://github.com/vyborovamaria3-maker/claude-project/pull/83) | docs(x-collector): archive historical integration reports | `main` | CLOSED UNMERGED | 2026-10-16 |
| [#82](https://github.com/vyborovamaria3-maker/claude-project/pull/82) | refactor(intelligence): remove 145 unreachable legacy modules | `main` | CLOSED UNMERGED | 2026-10-16 |
| [#81](https://github.com/vyborovamaria3-maker/claude-project/pull/81) | chore(x-collector): audit potentially unused legacy code | `main` | MERGED | 2026-10-16 |
| [#80](https://github.com/vyborovamaria3-maker/claude-project/pull/80) | fix(x-collector): preserve claimed tasks during PostgreSQL outages | `main` | MERGED | 2026-10-16 |
| [#79](https://github.com/vyborovamaria3-maker/claude-project/pull/79) | refactor(intelligence): remove 145 unreachable legacy modules | `main` | CLOSED UNMERGED | 2026-10-16 |
| [#78](https://github.com/vyborovamaria3-maker/claude-project/pull/78) | chore(x-collector): audit potentially unused code before removal | `main` | CLOSED UNMERGED | 2026-10-16 |
| [#77](https://github.com/vyborovamaria3-maker/claude-project/pull/77) | docs(x-collector): keep generated structure snapshots out of repository root | `main` | MERGED | 2026-10-16 |
| [#76](https://github.com/vyborovamaria3-maker/claude-project/pull/76) | fix(migrations): enforce explicit SQL inventory before database access | `main` | MERGED | 2026-10-16 |
| [#75](https://github.com/vyborovamaria3-maker/claude-project/pull/75) | refactor(intelligence): remove 15 unused agent scaffolding modules | `main` | CLOSED UNMERGED | 2026-10-16 |
| [#74](https://github.com/vyborovamaria3-maker/claude-project/pull/74) | chore(x-collector): audit potential unused intelligence modules with Knip | `main` | CLOSED UNMERGED | 2026-10-16 |
| [#73](https://github.com/vyborovamaria3-maker/claude-project/pull/73) | docs(x-collector): move historical process reports out of root | `main` | MERGED | 2026-10-16 |
| [#72](https://github.com/vyborovamaria3-maker/claude-project/pull/72) | chore(x-collector): audit legacy migration inventory before database writes | `main` | CLOSED UNMERGED | 2026-10-16 |
| [#71](https://github.com/vyborovamaria3-maker/claude-project/pull/71) | feat: modular TG Collector with evidence graph and channel analytics | `main` | MERGED | 2026-10-18 |
| [#69](https://github.com/vyborovamaria3-maker/claude-project/pull/69) | Stabilize X Collector after PostgreSQL outages and classify XActions failures | `main` | MERGED | 2026-10-16 |
| [#68](https://github.com/vyborovamaria3-maker/claude-project/pull/68) | Add cached Solana wallet forensics with conservative PnL and coverage | `main` | MERGED | 2026-10-18 |
| [#67](https://github.com/vyborovamaria3-maker/claude-project/pull/67) | Blockchain Settings V2: persisted controls, Excel imports and real monitoring | `main` | MERGED | 2026-10-17 |
| [#66](https://github.com/vyborovamaria3-maker/claude-project/pull/66) | feat(settings): Blockchain tab with Solana RPC health and data-source overview | `main` | MERGED | 2026-10-15 |
| [#65](https://github.com/vyborovamaria3-maker/claude-project/pull/65) | Alchemy-first Solana collector, inventory evidence and reconciliation | `main` | MERGED | 2026-10-18 |
| [#64](https://github.com/vyborovamaria3-maker/claude-project/pull/64) | Restore HTTP search pagination and parallel historical collection | `main` | MERGED | 2026-10-14 |
| [#63](https://github.com/vyborovamaria3-maker/claude-project/pull/63) | Preserve native XActions ESM imports in compiled collector | `main` | MERGED | 2026-10-14 |
| [#62](https://github.com/vyborovamaria3-maker/claude-project/pull/62) | WIP: TGInvite owner isolation, session vault, login throttling, incremental Telegram collector and exports | `main` | MERGED | 2026-10-18 |
| [#61](https://github.com/vyborovamaria3-maker/claude-project/pull/61) | Add opt-in XActions HTTP collector with durable PostgreSQL checkpoints | `main` | MERGED | 2026-10-14 |
| [#60](https://github.com/vyborovamaria3-maker/claude-project/pull/60) | Show collector data in Control Center tables with read-only access | `codex/staged-discovery` | MERGED | 2026-10-13 |
| [#59](https://github.com/vyborovamaria3-maker/claude-project/pull/59) | Collect three-list archive before staged Solana discovery | `main` | MERGED | 2026-10-13 |
| [#58](https://github.com/vyborovamaria3-maker/claude-project/pull/58) | Improve list collection with durable checkpoints and account fallback | `codex/local-runtime-reliability` | MERGED | 2026-10-12 |
| [#57](https://github.com/vyborovamaria3-maker/claude-project/pull/57) | Remove workspace navigation from the public landing page | `main` | MERGED | 2026-10-12 |
| [#56](https://github.com/vyborovamaria3-maker/claude-project/pull/56) | Fix scheduler pool starvation and analytics duration overflow | `main` | MERGED | 2026-10-12 |
| [#55](https://github.com/vyborovamaria3-maker/claude-project/pull/55) | Stabilize X Collector runtime and recover from account failures | `main` | MERGED | 2026-10-12 |
| [#54](https://github.com/vyborovamaria3-maker/claude-project/pull/54) | Codex/intelligence identity resolution | `main` | CLOSED UNMERGED | 2026-10-11 |
| [#53](https://github.com/vyborovamaria3-maker/claude-project/pull/53) | Merge pull request #45 from vyborovamaria3-maker/codex/pr63-graph | `main` | MERGED | 2026-10-11 |
| [#52](https://github.com/vyborovamaria3-maker/claude-project/pull/52) | Merge pull request #46 from vyborovamaria3-maker/codex/pr64-api | `main` | MERGED | 2026-10-11 |
| [#51](https://github.com/vyborovamaria3-maker/claude-project/pull/51) | Merge pull request #47 from vyborovamaria3-maker/codex/pr65-investiga… | `main` | MERGED | 2026-10-11 |
| [#50](https://github.com/vyborovamaria3-maker/claude-project/pull/50) | Codex/pr65 investigation | `main` | MERGED | 2026-10-11 |
| [#49](https://github.com/vyborovamaria3-maker/claude-project/pull/49) | feat(intelligence): multi-chain adapters, registry and evidence-backed cross-chain correlation | `main` | MERGED | 2026-10-11 |
| [#48](https://github.com/vyborovamaria3-maker/claude-project/pull/48) | feat(intelligence): health, retention, audit log and evidence-first hardening | `codex/pr65-investigation` | MERGED | 2026-10-10 |
| [#47](https://github.com/vyborovamaria3-maker/claude-project/pull/47) | feat(intelligence): autonomous investigation runner with evidence-linked steps | `codex/pr64-api` | MERGED | 2026-10-10 |
| [#46](https://github.com/vyborovamaria3-maker/claude-project/pull/46) | feat(intelligence): layered intelligence API and investigations schema | `codex/pr63-graph` | MERGED | 2026-10-10 |
| [#45](https://github.com/vyborovamaria3-maker/claude-project/pull/45) | feat(intelligence): graph embeddings, link prediction and core graph engines | `codex/pr62-identity` | MERGED | 2026-10-10 |
| [#44](https://github.com/vyborovamaria3-maker/claude-project/pull/44) | feat(intelligence): identity core with evidence-first entity and identity resolution | `main` | MERGED | 2026-10-10 |
| [#43](https://github.com/vyborovamaria3-maker/claude-project/pull/43) | Codex/pr62 multichain | `main` | MERGED | 2026-10-10 |
| [#42](https://github.com/vyborovamaria3-maker/claude-project/pull/42) | feat: add evidence-backed intelligence data foundation | `main` | MERGED | 2026-10-10 |
| [#41](https://github.com/vyborovamaria3-maker/claude-project/pull/41) | feat: add resumable two-year X archive and collector controls | `main` | MERGED | 2026-10-10 |
| [#40](https://github.com/vyborovamaria3-maker/claude-project/pull/40) | Add individual IPv6 proxies and account health checks for X Collector | `main` | MERGED | 2026-10-10 |
| [#39](https://github.com/vyborovamaria3-maker/claude-project/pull/39) | Feat/x collector admin | `main` | MERGED | 2026-10-09 |
| [#38](https://github.com/vyborovamaria3-maker/claude-project/pull/38) | feat: X Collector intelligence, autopost and publisher UI | `main` | MERGED | 2026-10-09 |
| [#37](https://github.com/vyborovamaria3-maker/claude-project/pull/37) | Add Solana social agent preview with separate accounts and admin controls | `feat/graph-signals-monitoring-v1` | MERGED | 2026-10-09 |
| [#36](https://github.com/vyborovamaria3-maker/claude-project/pull/36) | Add graph signals and autonomous monitoring v1 | `feat/x-collector-admin` | MERGED | 2026-10-09 |
| [#35](https://github.com/vyborovamaria3-maker/claude-project/pull/35) | Make X Collector start from dashboard with reliable collection and database storage | `main` | MERGED | 2026-10-09 |
| [#34](https://github.com/vyborovamaria3-maker/claude-project/pull/34) | fix: resolve all 57 TypeScript errors from blockchain v1.1 merge | `main` | MERGED | 2026-10-05 |
| [#33](https://github.com/vyborovamaria3-maker/claude-project/pull/33) | Blockchain v1.1 | `main` | MERGED | 2026-10-05 |
| [#32](https://github.com/vyborovamaria3-maker/claude-project/pull/32) | integration: adapt all historical work onto current architecture | `main` | MERGED | 2026-10-09 |
| [#31](https://github.com/vyborovamaria3-maker/claude-project/pull/31) | integration: absorb all open work safely | `main` | MERGED | 2026-09-16 |
| [#30](https://github.com/vyborovamaria3-maker/claude-project/pull/30) | deploy: add safe one-command server rollout | `integration/all-open-work-20260916` | MERGED | 2026-09-16 |
| [#29](https://github.com/vyborovamaria3-maker/claude-project/pull/29) | integration: resolve Twitter/X monitoring stack onto current main | `main` | MERGED | 2026-09-15 |
| [#28](https://github.com/vyborovamaria3-maker/claude-project/pull/28) | integration: Twitter/X registry monitoring stack into main | `main` | CLOSED UNMERGED | 2026-09-13 |
| [#27](https://github.com/vyborovamaria3-maker/claude-project/pull/27) | feat(admin): add Twitter/X monitoring dashboard | `feature/twitter-account-registry-v1` | CLOSED UNMERGED | 2026-10-09 |
| [#26](https://github.com/vyborovamaria3-maker/claude-project/pull/26) | feat: harden API-optional Twitter/X discovery and analysis pipeline | `integration/all-open-work-20260916` | MERGED | 2026-09-16 |
| [#25](https://github.com/vyborovamaria3-maker/claude-project/pull/25) | feat: add scalable TeraGram ingestion and TG Invite source | `main` | MERGED | 2026-09-11 |
| [#24](https://github.com/vyborovamaria3-maker/claude-project/pull/24) | Finish trade analysis verdict and Telegram first-call | `main` | MERGED | 2026-09-16 |
| [#23](https://github.com/vyborovamaria3-maker/claude-project/pull/23) | fix: route Telegram bot through configured SOCKS proxy | `main` | MERGED | 2026-09-07 |
| [#22](https://github.com/vyborovamaria3-maker/claude-project/pull/22) | perf: parallelize POTAPoff analytics hot paths | `main` | MERGED | 2026-09-16 |
| [#21](https://github.com/vyborovamaria3-maker/claude-project/pull/21) | security: remediate vibe-audit findings in solana-launcher | `main` | MERGED | 2026-09-06 |
| [#20](https://github.com/vyborovamaria3-maker/claude-project/pull/20) | security: move Strix off GitHub Actions | `main` | MERGED | 2026-09-06 |
| [#19](https://github.com/vyborovamaria3-maker/claude-project/pull/19) | security: harden project and add fail-closed Strix PR gate | `main` | MERGED | 2026-09-06 |
| [#18](https://github.com/vyborovamaria3-maker/claude-project/pull/18) | fix: restore production deploy workflow | `main` | MERGED | 2026-09-03 |
| [#17](https://github.com/vyborovamaria3-maker/claude-project/pull/17) | audit: W0.2-W1.8 code fixes + branch cleanup | `main` | MERGED | 2026-09-03 |
| [#16](https://github.com/vyborovamaria3-maker/claude-project/pull/16) | audit: architecture plan + emergency fixes (W0.8, W1.7, OPS-314) | `main` | MERGED | 2026-09-03 |
| [#15](https://github.com/vyborovamaria3-maker/claude-project/pull/15) | feat: secure Mini App access and manage subscription from main admin | `main` | MERGED | 2026-09-04 |
| [#14](https://github.com/vyborovamaria3-maker/claude-project/pull/14) | fix: restore Mini App subscription activation | `main` | MERGED | 2026-09-01 |
| [#13](https://github.com/vyborovamaria3-maker/claude-project/pull/13) | feat: wire admin control center into production deploy | `main` | MERGED | 2026-08-29 |
| [#12](https://github.com/vyborovamaria3-maker/claude-project/pull/12) | Restore/trade analysis 129 visible | `main` | MERGED | 2026-08-29 |
| [#11](https://github.com/vyborovamaria3-maker/claude-project/pull/11) | Split/social v5 intelligence | `integration/all-open-work-20260916` | MERGED | 2026-09-16 |
| [#10](https://github.com/vyborovamaria3-maker/claude-project/pull/10) | release: prepare full production deployment | `main` | MERGED | 2026-09-16 |
| [#9](https://github.com/vyborovamaria3-maker/claude-project/pull/9) | security: full audit hardening and payment integrity fixes | `main` | MERGED | 2026-08-18 |
| [#8](https://github.com/vyborovamaria3-maker/claude-project/pull/8) | chore: add repository hygiene guardrails | `main` | MERGED | 2026-08-17 |
| [#7](https://github.com/vyborovamaria3-maker/claude-project/pull/7) | Harden admin P0/P1/P2 scaling, observability and shared state | `main` | MERGED | 2026-08-17 |
| [#6](https://github.com/vyborovamaria3-maker/claude-project/pull/6) | Enforce provenance for Analysis · 129 snapshots | `main` | MERGED | 2026-08-17 |
| [#5](https://github.com/vyborovamaria3-maker/claude-project/pull/5) | Adapt Telegram Mini App to Hologram Plasma frontend | `main` | MERGED | 2026-08-17 |
| [#4](https://github.com/vyborovamaria3-maker/claude-project/pull/4) | Restore 129-parameter Analysis tab | `main` | MERGED | 2026-08-14 |
| [#3](https://github.com/vyborovamaria3-maker/claude-project/pull/3) | Restore approved public landing and login flow | `main` | CLOSED UNMERGED | 2026-08-19 |
| [#2](https://github.com/vyborovamaria3-maker/claude-project/pull/2) | Codex/admin login error | `main` | CLOSED UNMERGED | 2026-09-03 |
| [#1](https://github.com/vyborovamaria3-maker/claude-project/pull/1) | Fix production registry and social intelligence build | `main` | MERGED | 2026-08-13 |

## Release-review checklist

For any release-critical PR document full head SHA, branch, reviewer, scope, required checks, secrets/DB safety, dependency/target branch, rollback and real evidence. A merged PR can target an **intermediate branch** rather than `main`, and no offline CI implies real production operations. For operator-required work see [KNOWN_GAPS](KNOWN_GAPS.md), [LIVE_TESTS](LIVE_TESTS.md) and [DELIVERY_PLAN](DELIVERY_PLAN_20261024.md).
