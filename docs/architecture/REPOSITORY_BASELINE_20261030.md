# Repository architecture baseline — 2026-10-30

<small>Read-only source and GitHub metadata review. This is an architecture inventory, not a production deployment certification.</small>

## Baseline identity

- Observed `main`: `9f4a7e88afa80774633ee4a43221a621fe5f1922` (commit timestamp 2026-10-28 12:09:26 UTC).
- Recursive Git tree: **4,791 entries**, **4,065 tracked file blobs**, **725 directories**; tree response was not truncated.
- GitHub workflow files: **38**.
- Architecture documents under `docs/architecture`: **43**.
- The repository is a multi-application monorepo. A directory, Compose file or workflow does not prove a live deployment or a distinct physical database.

## Repository footprint

Tracked file counts by top-level workspace (selected largest areas):

| Workspace | Files | Main responsibility |
| --- | ---: | --- |
| `cockpit-tools` | 1,409 | Desktop/tooling workspace; includes Tauri/Rust and Go/Node sidecars |
| `solana-launcher` | 1,168 | POTAPoff Next.js product UI/API, Python backend, blockchain evidence and local worker scripts |
| `x-collector` | 487 | X collection, durable source records, analytics and separate publishing runtime |
| `intelligence` | 234 | Node event/feature runtime plus a separate Python provider/NLP runtime |
| `tg-collector` | 139 | Telegram MTProto collection, PostgreSQL state, analytics and token verification |
| `memecoin-intelligence` | 125 | Separate React/Vite + Fastify research product |
| `admin-site` | 103 | Separate operational Control Center |
| `solana-subscription-service` | 91 | Subscription web/API/bot product |
| `packages` | 55 | Optional shared contracts, outbox, DB and utility packages |
| `telegram-miniapp` | 54 | Separate demo Mini App and bot |

These counts are a file inventory only; they are not complexity, ownership or runtime counts.

## System map

| Workspace | Runtime and data boundary | Verified code-level role | Important limitation |
| --- | --- | --- | --- |
| `x-collector` | Node.js/TypeScript; dedicated PostgreSQL; explicit historical migration manifest | X collection, tasks/retries, source evidence, opt-in source outbox, bounded Alchemy-backed token-link verification CLI | Do not infer live X account access, full history or automatic token proof from code presence |
| `tg-collector` | Node.js/TypeScript; GramJS/MTProto; dedicated PostgreSQL and native SQL migration ledger | Public-channel collection, checkpoints, source revisions, opt-in outbox and Alchemy SPL/Token-2022 mint resolver | Session, provider and source flags are operator-controlled; history coverage can be partial |
| `solana-launcher` | Next.js frontend/API plus Python backend/Alembic; local SQLite trade evidence and multiple worker/bot scripts | POTAPoff analysis UI, blockchain evidence, local collector tooling and authenticated API proxies | Not one database or one always-on service; the README documents local operation and no remote server as the current default |
| `intelligence` — Node runtime | Node.js/TypeScript; separate destination PostgreSQL; reads source-local X/TG PostgreSQL and blockchain SQLite | Event inbox, canonical entities/evidence, token-link observations, timeline/features, read-only API and foreground ETL supervisor | ETL is opt-in and does not start collectors, apply migrations or prove live source delivery |
| `intelligence` — Python runtime | Python provider/NLP/scoring and document/job storage | Separate POTAPoff document/provider intelligence capability | Must not be conflated with the Node outbox/timeline runtime or its database |
| `memecoin-intelligence` | React/Vite, Fastify, PostgreSQL, Redis/BullMQ, optional Qwen service | Standalone research/graph/feature application | Separate product schema and runtime; not the Node Intelligence destination |
| `admin-site` | Python Control Center with its own operational state | Read-only exploration/monitoring of configured product PostgreSQL/SQLite sources; flags, alerts and audit trail in its own state store | Read-only configuration is not proof that every source is connected or current |
| `solana-subscription-service` | Next.js web, Express API, Telegraf bot, Prisma/PostgreSQL, Redis/BullMQ and Solana RPC | Subscription, wallet/payment verification and notifications | Separate billing/auth/data boundary; do not merge its state with trade/collector DBs |
| `telegram-miniapp` | Vite/React frontend and aiogram/SQLite demo bot | Legacy/demo Mini App and mock swap/payment UI | Not the same application or database as `solana-subscription-service` |
| `packages` | Local npm packages | Canonical IDs/evidence contracts, transactional outbox adapters, DB migration helpers, shared utilities and AI gateway | Package presence does not mean every collector is rewired; X has its own migration manifest |
| `mcp-servers`, `scripts`, `.agents` | Supporting utilities and developer automation | Tooling and repeatable workflows | Not independent production products by default |

## Data and trust boundaries

1. X, Telegram, blockchain, Node Intelligence, Python Intelligence, Memecoin Intelligence, Admin and Subscription are separate ownership/storage domains. Do not consolidate databases or authentication domains based on directory names.
2. X and Telegram source records remain in their own PostgreSQL databases. Blockchain seed/evidence state is local SQLite with WAL-aware handling. Node Intelligence has a separate destination PostgreSQL.
3. The Node ETL supervisor is a foreground local process. It requires both `INTELLIGENCE_ETL_ENABLED=true` and `INTELLIGENCE_SUPERVISOR_ENABLED=true`, validates the selected source schemas before claiming, uses a one-event batch per source, and drains active batches on SIGINT/SIGTERM. It does not start source collectors or apply migrations.
4. X verified token-link production is a separate bounded CLI and requires explicit execution plus the X outbox/token-link/mint-verification opt-ins and Alchemy proof. TG mint resolution is a separate explicit resolver and requires its outbox and token-link flags. Blockchain also emits opt-in provider-parsed swap evidence and raw-revision state: only a single unambiguous SOL/WSOL-quoted wallet leg with balance reconciliation is accepted, and a later unsupported raw revision supersedes prior supported evidence. This is historical parser evidence, not independent SPL Mint account proof, authenticated RPC provenance, finalized/reorg assurance or a complete trade tape. The current RPC receipt validator is offline-only and does not fetch RPC.
5. Shared `packages/contracts` validates identity and evidence shapes; it does not prove economic safety, wallet ownership or mint legitimacy by itself.
6. Outbox delivery is at-least-once. Destination commit must precede source ACK; replay is expected and idempotency/collision checks are required.

## CI and release posture

- The tree contains 38 workflow definitions across product quality, backend/database, intelligence, security, hygiene, mobile and release/deploy concerns.
- GitHub branch metadata currently reports `main` as `protected:false` at the observed SHA. The detailed protection endpoint is not readable by this connection; repository-admin action is tracked in [issue #170](https://github.com/vyborovamaria3-maker/claude-project/issues/170).
- CI uses disposable test services/fixtures for many checks. A green workflow proves only the checks and commit it ran against; it does not certify live X/TG/RPC operation, production migrations, backups/restores, complete history or trading performance.
- Root README states the current documented operating mode is local/offline development and that no remote server/deploy is required by ordinary checks.
- At this snapshot, open PRs observed: [#204](https://github.com/vyborovamaria3-maker/claude-project/pull/204) (draft, admin collector relocation), [#203](https://github.com/vyborovamaria3-maker/claude-project/pull/203) (unified Analysis UI), [#202](https://github.com/vyborovamaria3-maker/claude-project/pull/202) (draft evidence-first analytics), [#195](https://github.com/vyborovamaria3-maker/claude-project/pull/195) (draft FOMO metrics). GitHub is authoritative for later state.

## Explicit non-claims

This baseline did not connect to any X or Telegram account, use a paid Solana RPC key, inspect production secrets, query or mutate a user database, run a production migration, restore a live backup, or deploy a service. Live operation, full source coverage, profitability, alpha, PnL correctness and production RPO/RTO remain unverified unless separately evidenced in [LIVE_TESTS.md](LIVE_TESTS.md).

## Related documents

- [Current architecture](CURRENT_ARCHITECTURE.md)
- [System dependency map](DEPENDENCY_MAP.md)
- [Technical debt register](TECHNICAL_DEBT_REGISTER_20261030.md)
- [Known gaps and historical evidence](KNOWN_GAPS.md)
- [Live test register](LIVE_TESTS.md)
- [Data ownership/contracts](DATA_CONTRACTS.md)
