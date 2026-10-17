# Blockchain Settings V2

Base: main `fa0b46f` (PR #66). That PR supplies the diagnostics tab, not an importer or worker. The reusable SQLite seed engine and evidence analytics are selectively brought forward from the unmerged PR #65 work; no second collector service, broker, database or X Collector process is introduced.

## Operator access and secrets

`/api/blockchain/settings` requires the existing backend `/api/v1/users/me` identity with `is_superuser=true`. Ordinary subscribers cannot change shared infrastructure settings or read private import metadata. Mutations additionally require a matching Origin. Development on a loopback-only app may explicitly set `BLOCKCHAIN_LOCAL_OPERATOR=1`; never expose that development instance on a public or LAN listener. Production never accepts this bypass. Errors do not return provider URLs, keys or subprocess output.

Secrets stay in server env (`HELIUS_API_KEY(S)`, `HELIUS_API_KEY_1`…`_5`, `HELIUS_RPC_URL`, `RPC_URL`, `SOLANA_RPC_URL`). Browser forms choose references to configured RPC slots, not URLs/keys. `default` preserves each existing call site's endpoint; explicit primary/fallback selection overrides the Blockchain Intelligence JSON-RPC provider and existing RPC health check. Read-only analytics calls can fail over; trading send/simulate RPCs are deliberately independent. No browser/localStorage secret storage is added. Existing legacy NEXT_PUBLIC settings are not rewritten by this change.

## Effective settings

Settings persist in the existing `data/trade.db`. The API, existing seed CLI and analytics JSON-RPC read them on use; a CLI watch process sees changes on its next scheduling cycle. Batch size bounds targets and recent/backfill pages; native analytics RPC batches additionally cap at 50. Concurrency, requests/sec and request leases share SQLite across web/CLI processes. HTTP requests retain leases through JSON body consumption, expire after bounded timeouts and release in finally. Retries/backoff are bounded and errors are sanitized. Retry attempts are shared across the configured Helius key list, not multiplied by nested rotation loops.

The collection gate pauses new claims. It does not pretend to launch a daemon. The UI runs one bounded existing collector batch and shows persisted run/heartbeat/error counters. For automatic local folder scanning and continuous collection, from the laptop's `solana-launcher` directory:

```sh
npm run blockchain:watch -- --migrated-dir "C:\data\migrated" --trending-dir "C:\data\trending" --wallets-dir "C:\data\wallets" --max-files 10000
npm run blockchain:status
npm run blockchain:analytics -- --kind wallet --limit 20
```

Keep X Collector on the laptop; none of its startup, account pools, PostgreSQL settings or endpoints are changed.

## Import and evidence flow

Browser directory selection uploads actual XLSX bytes sequentially. It does not grant a persistent Windows folder path or let the server browse arbitrary local directories. Browser uploads are bounded to 16 MiB/file; larger files and large folder sets use the existing local CLI. Safe Python XLSX decoding retains the project's archive/XML/cell limits. The same category/header/public-key validator, source masks and target queue serve CLI and uploads. File content SHA-256 deduplicates successful uploads within a category, even after renaming; addresses deduplicate by `(kind,address)` across overlapping files. Cross-category provenance remains distinct. Import success/error history returns names/counts only, not filesystem paths.

Collector evidence remains gzip-compressed in `chain_seed_events`; resumable cursors/leases remain in `chain_seed_targets`. Successful token swaps write through the existing `persistTokenTrades` into `token_trades`, which the existing trade cache and chain provider already read. Wallet histories discover owner-bound mints. Existing profitability, funding-group and suspicious-operation analytics remain intact; they are accessed from the tab's mint link. Seed coverage and raw-amount metrics are also available through `blockchain:analytics`. The separate PostgreSQL Intelligence entity graph is linked for navigation; this change does not copy SQLite evidence into that graph or claim that it already contains these imports.

Excel labels never establish profitability or migration. A provider's exhausted address history is not complete mint-wide trade coverage; missing ATA/program histories and evidence gaps remain explicit. Failed or ambiguous multi-asset/owner transactions are retained as evidence and do not manufacture swap prices. Existing historical normalized rows are preserved, not silently reclassified or deleted.

## Architecture issues and next throughput work

- PR #66 was mostly hardcoded Russian diagnostics; it had no control persistence or collector integration. This tab now supplies RU/EN labels through the existing locale context.
- PR #65 was not in main, so claiming an existing main-branch seed worker would have been false. Necessary modules are reused explicitly in this diff.
- Independent RPC endpoint precedence and module-level concurrency constants prevented hot settings. The server analytics adapter now uses persisted settings; trading remains outside this control plane.
- Browser imports run on the app host, not automatically on the user's laptop. Production uploads and local CLI databases are distinct unless the same actual data volume is used; do not copy private laptop data to production implicitly.
- Next optimizations: program/pool-indexed historical reconciliation, ATA-inclusive wallet backfill, request-credit quotas per provider key, deduplication of decoded instruction legs, and large-folder import batching. Measure production throughput before increasing rate/concurrency.

## Verification

`npm run blockchain:test` exercises settings validation/persistence, superuser and Origin authorization, real XLSX imports and dedup, RPC fallback/errors, shared throttling/concurrency, lease fencing/rollback and read-only evidence reports. Run strict typecheck, scoped ESLint, existing analysis/security regression and production build. The new GitHub workflow executes offline contracts and build without production API keys.

Local verification: blockchain contracts, existing analysis/security regressions, strict TypeScript and production Next.js build passed. Repository-wide ESLint exits 0 with 345 warnings; changed modules have no lint errors (legacy provider/db warnings remain). RPC failure/fallback tests use controlled responses, not paid provider calls. Deployment-specific backend superuser access, configured private RPCs and browser interaction still require operator acceptance in the target environment.

## Changed files

- UI and routes: `app/settings/BlockchainTab.tsx`, `app/api/blockchain/settings/route.ts`, `app/api/rpc-health/route.ts`.
- Integration: `lib/blockchain-settings.ts`, `lib/trade/chain/provider.ts`, `lib/trade/helius.ts`, `lib/trade/db.ts`.
- Reused seed engine: `scripts/blockchain-seed-{core,collector,analytics}.cjs`.
- Contracts: `scripts/blockchain-settings-test.cjs`, `scripts/blockchain-seed-{regression,integration,persistence-test,analytics-test}.cjs`.
- Packaging and CI: `next.config.js`, `package.json`, repository `.github/workflows/blockchain-settings.yml`.
- Documentation: this document and repository `docs/CODEX_PROJECT_CONTEXT.md`, `docs/CODEX_PROGRESS.md`.
