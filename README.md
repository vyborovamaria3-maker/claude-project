# claude-project

Multi-application repository for **Solana token research, X and Telegram collection, source-evidence processing, and several independent product/tooling workspaces**. This is a **monorepo**, not a single production deployment or a claim that every component is live.

> **Readiness snapshot (2026-10-30):** this monorepo contains 4,065 tracked files across independent product, collector, Intelligence and tooling workspaces. Canonical contracts, opt-in source outboxes, verified X/TG mint-link code, provider-parsed blockchain swap evidence/revisions, offline two-witness receipt acceptance ([design and limits](solana-launcher/docs/BLOCKCHAIN_FINALITY_WITNESS_QUORUM_V1.md)), a foreground local ETL supervisor and extensive offline/CI tests exist. A complete live X/TG/blockchain token timeline, production DB inventory, backup/restore, full historical coverage and trading-signal validity are **not verified as a whole**. GitHub currently reports `main` as unprotected; see [P0 issue #170](https://github.com/vyborovamaria3-maker/claude-project/issues/170). The current architecture, dependency boundaries and P0/P1 debt are recorded in [the 2026-10-30 baseline](docs/architecture/REPOSITORY_BASELINE_20261030.md), [system dependency map](docs/architecture/DEPENDENCY_MAP.md) and [technical debt register](docs/architecture/TECHNICAL_DEBT_REGISTER_20261030.md). See also [known gaps](docs/architecture/KNOWN_GAPS.md), [live test register](docs/architecture/LIVE_TESTS.md), and [PR status](docs/architecture/PR_STATUS.md).

## System map

| Area | Directory | Responsibility |
| --- | --- | --- |
| X source | [`x-collector/`](x-collector/) | X collection, durable source records, analytics, and separate autoposting runtime |
| Telegram source | [`tg-collector/`](tg-collector/) | Telegram ingestion, source/evidence, token candidates, and opt-in analytics/refresh |
| Chain/product UI | [`solana-launcher/`](solana-launcher/) | Blockchain evidence and Solana/POTAPoff frontend/backend workspace |
| Cross-source Intelligence | [`intelligence/`](intelligence/) | **Two distinct runtimes**: Node/TypeScript event-inbox, registry/timeline/features; Python document/provider NLP and scoring. Do not conflate their stores or deployment processes. |
| Shared contracts | [`packages/contracts/`](packages/contracts/) | Validated canonical IDs, event identities, timestamps, provenance |
| Transactional outbox | [`packages/event-outbox/`](packages/event-outbox/) | Source-local PostgreSQL/SQLite at-least-once delivery primitives (not a hosted message broker) |
| Common packages | [`packages/db-common/`](packages/db-common/), [`packages/shared-utils/`](packages/shared-utils/) | Supporting utilities |
| Research product | [`memecoin-intelligence/`](memecoin-intelligence/) | Separate research/graph/feature application, not automatically the Node Intelligence database |
| Product / operations | [`admin-site/`](admin-site/), [`solana-subscription-service/`](solana-subscription-service/), [`telegram-miniapp/`](telegram-miniapp/) | Independent admin, subscription, and Telegram app scopes |
| Supporting workspaces | [`mcp-servers/`](mcp-servers/), [`cockpit-tools/`](cockpit-tools/), [`pumpfun-chart/`](pumpfun-chart/), [`scripts/`](scripts/), [`.agents/`](.agents/) | Utilities, prototypes, automation, and developer workflows |

A directory is **not necessarily a deployable app, product, or separate database**. Counts such as “14 apps / 9 databases” are not maintained as verified production inventory. Refer to [data ownership and storage contracts](docs/architecture/DATA_CONTRACTS.md) instead.

## Работа без сервера — локальный Token Intelligence (2026-10-25)

Сейчас **удалённого сервера нет, деплой не требуется**. Для безопасной разработки достаточно offline CI и локальных тестовых данных. Изменения защиты релизов из [PR #186](https://github.com/vyborovamaria3-maker/claude-project/pull/186) включены в main через [PR #188](https://github.com/vyborovamaria3-maker/claude-project/pull/188); автоматический production deploy требует явного включения. Локальный отчёт по mint не запускает деплой и не требует изменений SSH/GHCR/release pipeline.

В рамках [PR #189](https://github.com/vyborovamaria3-maker/claude-project/pull/189) добавлен локальный просмотр доказательств для одного Solana mint без HTTP-сервера и AI-провайдера:

```sh
npm --prefix intelligence run token:report -- \
  --mint So11111111111111111111111111111111111111112 --demo --json
```

`--demo` выводит **явно синтетические** X/TG/blockchain фикстуры и не подключается к БД, RPC или аккаунтам. Для фактической локальной тестовой БД есть отдельный **явно разрешаемый** read-only PostgreSQL режим с loopback-only подключением. Он не запускает коллекторы. См. [инструкцию Intelligence](intelligence/README.md). Отсутствие результатов не означает отсутствие активности; финальность транзакций, PnL и прогнозная пригодность AI не подтверждаются.

## Source → Intelligence architecture

```text
X Collector ──────── local PostgreSQL + opt-in outbox ─┐
Telegram Collector ── local PostgreSQL + opt-in outbox ─┼─→ Node Intelligence
Blockchain evidence ─ local SQLite + opt-in outbox ────┘   (separate PostgreSQL)
                                                             │
                                                   registry / evidence / timeline
                                                             │
                                                versioned read-only API / UI
```

- An outbox is written in the **same transaction** as the source observation. Consumer ACK is allowed only after destination commit; retries and duplicate deliveries are expected and must be idempotent.
- A matching ticker, X handle, Telegram username, address-shaped string, or wallet observation is **not** proof of the same token. `solana:<full-mint>` is a canonical ID **only for verified token links**; revisions and retractions must preserve per-source provenance.
- `occurredAt` and `observedAt` serve different purposes. Historical “known at time” queries must not use subsequently observed information.
- Source outbox flags and AI features are opt-in/default-off. **No live account, paid RPC, database migration, or third-party post is required by the ordinary offline checks.**

Details: [contracts](docs/architecture/DATA_CONTRACTS.md), [outbox contract](packages/event-outbox/README.md), [Intelligence](intelligence/README.md), [architecture](docs/architecture/CURRENT_ARCHITECTURE.md).

## Getting oriented / safe offline checks

Use the README and environment requirements of **each workspace**; there is no one-command deployment of the whole monorepo. For shared foundation checks, use Node.js 22+ and separate, disposable test databases where requested:

```sh
npm install --prefix packages/contracts --ignore-scripts --no-package-lock
npm --prefix packages/contracts run check
npm install --prefix packages/event-outbox --ignore-scripts --no-package-lock
npm --prefix packages/event-outbox run check
npm install --prefix intelligence --ignore-scripts --no-package-lock
npm --prefix intelligence run check
```

Intelligence DB integration tests can require PostgreSQL 16 and a **disposable** `INTELLIGENCE_TEST_DB_URL`. Read [intelligence/README.md](intelligence/README.md) before enabling any runtime. Passing these tests does **not** verify an external X/TG session, chain RPC, live publisher, or production backup.

### Existing deployable candidate — subscriptions

[`solana-subscription-service/`](solana-subscription-service/) has a standalone API/web/bot, Prisma/PostgreSQL, Redis and deployment configuration. Its deployment path is documented in [Oracle/Coolify instructions](solana-subscription-service/docs/oracle-coolify.md). It is **one independent deployment candidate**, not the prescribed entry point for deploying the entire repo or evidence that cross-source Intelligence is live.

## Product direction and release gates

**Proposed MVP:** a *Token Intelligence* view keyed by a verified Solana mint, displaying source-qualified X/TG observations, applicable on-chain evidence, event/observation times, provenance, and honest coverage/unknown states. This is a **proposal pending user validation**, not a proven market or a guarantee of profitable signals. Other codebases can remain modules or separate products.

Before labeling the cross-source experience production-ready:

1. Enforce reviewed branch/CI governance and clear the applicable Security Gates.
2. Verify independent source DB migrations, backups **and tested restores** without using production as an audit fixture.
3. Prove verified mint linking, per-source retractions, replay/failed-ACK/restart behavior, and a bounded supervised consumer.
4. Record **real** opt-in X, Telegram and chain observations with timestamps, SHA, sanitized logs and operator authorization; keep unexecuted tests as `NOT RUN`.
5. Validate auth/read scopes, observability, incident response and a complete user-facing use case; measure product utility independently of CI.

## Documentation and work tracking

- [DATA_CONTRACTS.md](docs/architecture/DATA_CONTRACTS.md) — independent stores, native/canonical identities, delivery semantics and explicit gaps.
- [KNOWN_GAPS.md](docs/architecture/KNOWN_GAPS.md) — implementation versus verification, blocking conditions.
- [LIVE_TESTS.md](docs/architecture/LIVE_TESTS.md) — offline/CI versus live evidence register and how to record an actual run.
- [PR_STATUS.md](docs/architecture/PR_STATUS.md) — point-in-time PR inventory; GitHub is authoritative for current status.
- [DELIVERY_PLAN_20261024.md](docs/architecture/DELIVERY_PLAN_20261024.md) — P0/P1/P2 execution order and acceptance gates.
- [Architecture decisions](docs/architecture/ARCHITECTURE_DECISIONS/) — proposed decisions and boundaries.
- [Deployment](docs/architecture/DEPLOYMENT.md), [Rollback](docs/architecture/ROLLBACK.md), [Security audit](SECURITY_AUDIT_REPORT.md).

## Security and local-data rules

Never commit `.env`, X cookies, Telegram sessions/2FA, private keys, bearer tokens, raw credentials or production database snapshots. Keep independent X/TG/chain storage ownership; do not merge or migrate data on the basis of a documentation audit. Avoid unapproved paid RPC calls, publishing, external model requests, or secret exposure. Prefer redacted evidence and explicit opt-in operator gates.
