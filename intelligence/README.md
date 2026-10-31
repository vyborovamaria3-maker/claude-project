# Intelligence — receiving events, timeline and feature snapshots

The Intelligence modules are built independently of collector databases.
Only the test workflow opens a disposable PostgreSQL 16 instance.

Migration order: 001_entity_registry.sql, 002_timeline.sql, 003_feature_store.sql, 004_token_link_observations.sql, 005_blockchain_swap_evidence_revisions.sql, then 006_cross_platform_analytics.sql and 008_alert_status_history.sql and 009_ai_analysis.sql, then 010_intelligence_governance.sql, 011_validation_preregistration.sql, 012_ai_shared_budget.sql, and 013_invalidation_retry_schedule.sql, followed by 014_privacy_evidence_indexes.sql. Migration 007_feature_embeddings_pgvector.sql is optional and requires pgvector on the PostgreSQL server. The analytics API requires 003, 004, 005, 006 and 008. Do not start the ETL supervisor against a target missing 004 (or 005 when ARCH-06b events are enabled).

- Ingest RegistryEvent after claiming a source outbox event; source ACK only after
  destination transaction commits. Consumer runDeliveryBatch remains a bounded,
  explicit library call. It is NOT connected to running collectors.
- Timeline queries filter both event occurrence and time first observed, so a
  late-arriving historical tweet cannot leak into an earlier known-at view.
- The feature registry has immutable version definitions. FEATURES_V1 contains
  user-specified token-level metrics. Missing sentiment or bot-ratio values are
  represented as null rather than silently as zero.
- Feature snapshots record as_of and max_input_observed_at. Later-observed
  inputs are rejected. Duplicate identical snapshots are accepted as no-op;
  conflicting revisions require a NEW explicit feature version or new as_of.
- A historical offline recomputation at an earlier as_of is NOT a proof that a
  trading signal was actually available at that moment. API and backtest reads
  also require snapshot/result creation timestamps to be no later than the
  requested as_of; this intentionally excludes late backfills from historical
  signal evaluation. A future production backtest must separately use feature
  publication times and observed labels.

CI builds the shared contract, event-outbox and Intelligence modules and tests
PostgreSQL transaction/replay, timeline cutoffs and feature schema invariants.
No X or Telegram account, blockchain provider, local production DB or session
is accessed by these tests.

Local commands (Node 22+):
  npm install --prefix packages/contracts --ignore-scripts --no-package-lock
  npm --prefix packages/contracts run check
  npm install --prefix packages/event-outbox --ignore-scripts --no-package-lock
  npm --prefix packages/event-outbox run check
  npm install --prefix packages/ai-gateway --no-package-lock
  npm --prefix packages/ai-gateway run check
  npm install --prefix intelligence --ignore-scripts --no-package-lock
  npm --prefix intelligence run check

Remaining: deployment-safe source migrations and opt-in real data verification,
backfill, blockchain reconciliation, verified token-link producers,
AI embeddings/training/outcome labels, secured APIs and operational runbooks.

## Bounded local ETL CLI (explicit opt-in)

There is no cloud collector or implicit background service. After reviewing and
installing the destination migrations in an isolated PostgreSQL database, and
source migrations for each local collector, an operator can run:

    npm run build
    node scripts/run.mjs --source tg --status
    INTELLIGENCE_ETL_ENABLED=true node scripts/run.mjs --source tg --once --limit 25

Other sources: `--source x`, `--source blockchain`. Environment variables:
`X_SOURCE_DATABASE_URL`, `TG_SOURCE_DATABASE_URL`,
`SOLANA_TRADE_DB_PATH`, and `INTELLIGENCE_DATABASE_URL`.

The status command only reads source outbox counts. The once command is
explicitly gated and handles one finite claim batch with destination transaction
commit before source ACK; no Telegram login, browser, provider request, replay
loop, background scheduling, or trading instruction is performed. Keep all
credentials in locally secured environment settings (never commit them).
For SQLite, use the absolute path to a verified local DB; do not open a live
`trade.db` until WAL-safe backup and restore rehearsal. Follow the staged
Codex handoff for source and consumer rollout.

Temporary PostgreSQL 16 + memory-only SQLite cross-DB tests prove synthetic
event integrity and replay. They do NOT prove sustained throughput, recovery
under provider outages, completeness of blockchain history, or live collection.


## ARCH-04 — foreground local ETL Supervisor (explicit opt-in)

`scripts/supervise.mjs` handles independent X, Telegram and Blockchain source
outboxes in the **foreground on the laptop**. It does not run a server, browser,
XActions, MTProto, Solana RPC, trades, publishers or migration command. The
existing `run.mjs --status` and `run.mjs --once` modes remain available.

**Prerequisites:** verified independent source outbox schemas, destination
Intelligence PostgreSQL migrations 001 and 002, WAL-safe backup/restore drill,
dedicated DB privileges, and a reviewed local configuration. Producers remain
disabled by default; do not turn them on merely because a consumer exists.

Windows PowerShell, from `intelligence` (never commit these variables):

```powershell
$env:INTELLIGENCE_ETL_ENABLED = 'true'
$env:INTELLIGENCE_SUPERVISOR_ENABLED = 'true'
# Use separately scoped connection strings and your verified local paths:
# $env:X_SOURCE_DATABASE_URL = '<X PostgreSQL DSN>'
# $env:TG_SOURCE_DATABASE_URL = '<Telegram PostgreSQL DSN>'
# $env:SOLANA_TRADE_DB_PATH = '<absolute path to trade.db>'
# $env:INTELLIGENCE_DATABASE_URL = '<separate Intelligence PostgreSQL DSN>'
node scripts/supervise.mjs --sources x,tg,blockchain
```

For a safe bounded isolated test, use
`node scripts/supervise.mjs --sources blockchain --max-batches 1`
with a **temporary copy** of SQLite and a disposable destination PostgreSQL.

Options: `--sources x,tg,blockchain` (any nonempty distinct subset),
`--poll-ms 2000`, `--pace-ms 100`, `--lease-ms 120000`,
`--max-failures 5`, `--max-batches 0` (zero means until Ctrl+C).

Runtime safeguards:

- One claimed event per source batch, bounded sequential processing per source.
- Independent asynchronous loops for the selected sources; no cross-source
  transaction or broker. Every loop has its own source connection/worker ID.
- Source lease renewal during a slow destination operation. Every renewal
  returns an exact updated fencing token; ACK/NACK uses the most recent token.
  Failed renewals block ACK and allow safe idempotent replay.
- Destination writes use a finite query/statement timeout. A connection error
  triggers a bounded retry delay; repeated failures stop the supervisor rather
  than silently retrying without bound.
- Ctrl+C/SIGTERM stops **new** claims and lets current destination operations
  finish before closing connection pools.
- Bounded JSON lines include counters and error **codes**, never event payloads,
  passwords or original exception strings.
- A read-only health snapshot is emitted at startup and every
  `--health-interval-ms` (default 30 seconds), plus after failed/lost-lease
  batches. It includes pending/ready/leased counts, retrying-event count and
  total retry attempts, delayed retries, dead-letter count, oldest pending
  timestamp/age, last successful progress timestamp/age, maximum pending
  attempts and the number of event kinds with multiple schema versions in the
  pending queue (a diagnostic signal, not an automatic incompatibility claim).
- Machine-readable alert records are emitted when any dead-letter exists, when
  oldest pending age exceeds `--alert-oldest-pending-ms` (default 5 minutes;
  zero disables this alert), or when pending attempts reach `--max-failures`.
  Alert records contain only source, bounded counters and an allowlisted code.
- These alerts are JSON log events, **not an external notification service**.
  A deployment must route supervisor stdout to its approved log/alert sink.
- Operator can inspect per-source backlog and dead letters using the existing
  read-only `run.mjs --source <source> --status`; it shares the same health
  metrics without claiming or mutating events.

Caveats: health alerts are structured stdout records only; no external alert delivery or process manager is configured. This implementation does not persist a machine-level process manager,
does not create a health HTTP service, does not apply migrations, and does not
validate a live X/TG/Blockchain producer or the real token-link resolver.
Startup after Windows restart requires explicit process launch. The current
one-shot CLI can claim more than one event, so its unstarted batch members are
not heartbeat-protected; keep its batch size small on slow destinations.

Cross-source timeline identity remains blocked by the missing evidence-based
token-link producer; the synthetic token-linked ARCH-03 integration test
does not establish real token recognition.


## Cross-platform analytics and API-backed AI

The cross-platform layer is additive. It uses the existing entity registry and timeline and stores immutable point-in-time snapshots in token_daily_cross_platform. A missing source remains null unless an explicit complete record exists in source_coverage_windows; absence of events alone is not evidence of zero activity. Initial score formulas are heuristics, not validated trading predictors. Momentum remains null until valid interval z-scores are supplied.

model_registry is the execution gate: intelligence/src/ai-analysis.ts only invokes a model with a matching task and status active. Provider API keys stay in the AI Gateway process environment and are never stored in PostgreSQL. packages/ai-gateway supports configured HTTPS OpenAI-compatible chat and embedding APIs; no local LLM is started or selected by the new Intelligence layer.

Build/test order:
```sh
npm install --prefix packages/ai-gateway --no-package-lock
npm --prefix packages/ai-gateway run check
npm install --prefix packages/contracts --no-package-lock
npm install --prefix packages/event-outbox --no-package-lock
npm install --prefix intelligence --no-package-lock
npm --prefix intelligence run check
```

A historical backtest requires explicit outcome labels in token_outcomes and valid source coverage. Example:
```sh
npm --prefix intelligence run backtest -- --signal attention_score --outcome price_2x_24h --from 2025-01-01 --to 2025-09-30 --threshold 2.0 --horizon-hours 24
```
The command fails when labels are missing or the complete outcome horizon has not elapsed; it prints cohort coverage counts instead of reporting selective precision. Statistical significance is not reported for repeated-token or overlapping random-control observations without an independent design. Migration 007 must be applied before using putFeatureEmbedding.

Telegram legacy automatic mode requires migration 015 and a supervised `analyze-ai --source tg --watch` process with AI/source snapshot opt-in. It starts at current source high water, drains new observations with a durable transactional cursor and skips startup history. See AI_PIPELINE.md for timestamp polling limitations and configuration; collector startup alone does not activate AI.

On-demand token analysis: migration 016 plus `INTELLIGENCE_AI_ON_DEMAND_ENABLED=true` enables authenticated empty-body POST `.../tokens/<encoded solana:mint>/analyze`. It reads the existing X/TG PostgreSQL stores and Solana SQLite token_trades cache for that mint only, makes at most one uncached AI attempt, verifies selected fact IDs and saves the report. Set the separate `INTELLIGENCE_AI_DATABASE_URL` writer and `INTELLIGENCE_AI_TOKEN_MODEL_ID`; keep background `INTELLIGENCE_AI_ENABLED`, ETL and supervisor opt-ins disabled for request-only operation. See AI_PIPELINE.md for bounds, source semantics and cache behavior.

## Без сервера: локальный отчёт по одному Solana mint (2026-10-25)

Для этого сценария **не нужен** production-сервер, публичный API, Telegram/X-аккаунт, Solana RPC или модель OpenAI. Только Node 22+ и установленные зависимости workspace; режим `--demo` также не требует PostgreSQL.

```bash
# Разрешённый демонстрационный сценарий: только маркированная СИНТЕТИЧЕСКАЯ фикстура.
npm --prefix intelligence run token:report -- \
  --mint So11111111111111111111111111111111111111112 --demo --json
```

Для чтения **собственной локальной тестовой** PostgreSQL-базы Intelligence с миграциями 001/002/004/005 и подтверждёнными source-qualified записями:

```bash
INTELLIGENCE_LOCAL_READ_ENABLED=true \
INTELLIGENCE_DATABASE_URL=postgresql://localhost:5432/intelligence_test \
npm --prefix intelligence run token:report -- \
  --mint So11111111111111111111111111111111111111112 \
  --known-at 2026-10-20T03:00:00Z \
  --occurred-before 2026-10-19T22:00:00Z --limit 20 --json
```

Токен можно передать в сыром виде или как канонический `solana:<mint>`. Время задаётся **UTC**. Без `--known-at` берётся текущее локальное время вызова, `occurred-before` по умолчанию совпадает с ним. Для воспроизводимости указывайте оба явно.

Защитные свойства: соединение **только с PostgreSQL loopback** (`localhost`, `127.0.0.1`, `::1`) и только с `INTELLIGENCE_LOCAL_READ_ENABLED=true`; обязательная валидация миграций, PostgreSQL `REPEATABLE READ READ ONLY` для совместного snapshot связей и timeline, строгий `as-of`, лимиты 1–100 и повторный allowlist полей вывода. Содержимое постов, private wallet IDs, SQL, credentials, дополнительные поля строк и исходные provider payload в отчёт не включаются. Ошибки соединения не печатают строку БД. Исходные коллекторы и Outbox вообще не читаются и не изменяются этой командой.

В отчёте **разделены** проверенные источником связи X/TG с SPL mint и blockchain provider-parsed swap revisions. Последние **не доказывают финальность**, trade tape или PnL. Числа — только **ограниченные выборки**, не полная статистика. При пустом результате полнота покрытия всё равно `unknown`, отсутствие данных **не равно нулевой активности**. Никакая AI-модель не вызывается: `ai: not_run_no_external_model`. `--demo` маркируется `SYNTHETIC_FIXTURE_NO_DATABASE` и не считается результатом наблюдения реальных источников.

Проверки: `npm --prefix intelligence test` запускает `tests/local-token-report.test.mjs` вместе с остальными Intelligence тестами; PG интеграционные проверки требуют только `INTELLIGENCE_TEST_DB_URL` для одноразовой тестовой БД. Реальная работа на аккаунтах X/TG, блокчейн-провайдерах и production без разрешения не запускается.

Связанные задачи: [#173](https://github.com/vyborovamaria3-maker/claude-project/issues/173) — достоверное происхождение; [#177](https://github.com/vyborovamaria3-maker/claude-project/issues/177) — UX одного токена; [#176](https://github.com/vyborovamaria3-maker/claude-project/issues/176) — отдельный дизайн AI API. Черновики [#166](https://github.com/vyborovamaria3-maker/claude-project/pull/166) и [#167](https://github.com/vyborovamaria3-maker/claude-project/pull/167) **не включаются** автоматически.
