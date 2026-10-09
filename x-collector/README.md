# X collector

This is the PostgreSQL X collector from fixed_project.zip, integrated as an isolated subsystem. It does not replace the existing SQLite collector inside solana-launcher.

## Migration chain and provenance

The repository contains the complete numbered 001–018 chain plus the graph-monitoring, intelligence and signals migrations (`012_graph_monitoring.sql`, `013_intelligence.sql`, `014_signals_engine.sql`). `003_performance.sql` is an additive reconstruction, not the recovered original: it indexes `twitter_tweets.first_seen_at`, `tweet_token_links.linked_at`, terminal `x_tasks.created_at`, and terminal `scrape_runs.started_at`. These columns are defined by 001/002. Do not substitute the similarly named memecoin-intelligence migration. Apply the chain to a disposable dedicated PostgreSQL database before deployment; a file's presence does not prove it has been applied to your database. `npm run migrate -- --status` reports recorded migration state. The runner validates the chain and prevents concurrent migration runs.

## Setup

The migration manifest in `lib/trade/migrations.ts` is shared by the runner and
integration tests. It includes migration `019_account_roles.sql`, which gives
existing accounts the `collector` role and supports separate publisher accounts.
Run `npm run migrate` before starting workers after upgrading. The old
`012_ai_reply_guy.sql` prototype is not part of this manifest; the supported
Reply Guy schema uses the isolated `012_reply_guy.sql` tables instead.

Use a dedicated PostgreSQL database named x_collector. Do not point this service at the main application database. The existing memecoin-intelligence PostgreSQL publishes port 5434; create a separate x_collector database there (or use another dedicated PostgreSQL instance), then copy .env.example to .env and set DATABASE_URL plus a permanent random 32-byte MASTER_KEY (64 hexadecimal characters or Base64). Keep the .env file and key out of Git. Losing or changing MASTER_KEY makes stored X sessions unreadable.

From the repository root:

~~~powershell
npm run x-collector:install
npm run x-collector:install-browser
npm run x-collector:migrate
npm run x-collector:login -- analyst1
npm run x-collector:search-mints -- --input data\solana-mints.txt --limit 100 --sort latest
npm run x-collector:worker
~~~

Quality checks (no database required):

~~~powershell
npm run x-collector:typecheck
npm run x-collector:lint
npm run x-collector:test
~~~

The mint file accepts one Solana address per line; blank lines and lines starting with # are ignored. The importer validates and deduplicates addresses, then queues one X search per mint. Start scheduler, dashboard and outbox publisher in separate terminals with x-collector:scheduler, x-collector:dashboard and x-collector:publisher.

Quality checks are wired up from the repository root:

~~~powershell
npm run x-collector:typecheck   # tsc --noEmit
npm run x-collector:lint        # eslint
npm run x-collector:test        # node:test via tsx (tests/**.test.ts)
~~~

Tests cover shared helpers, browser navigation under CSP, partial API failures, encrypted sessions, and actual queue/account SQL against disposable PGlite. No external database or X credentials are required. The bundled test Chromium targets Linux; on other systems install a compatible Chromium and set TEST_CHROMIUM_PATH to its executable. PGlite tests do not replace multi-process integration checks on a dedicated PostgreSQL server.

Dashboard and metrics bind to loopback by default. External binds require Basic Auth and TLS at a reverse proxy. X login restrictions, captcha challenges and rate limits are surfaced as failures; the collector does not rotate identities to evade a platform restriction. Results are bounded by X search availability and configured limits, so the collector cannot guarantee every account or historical post.

Timeline refreshes store posts without linking every post to the mint that originally led to the account. Only search results explicitly queued for a mint create tweet-to-mint links.

The archive report is retained as FIX_REPORT_RU.md. It describes the supplied source snapshot and its verification limits.

See [DEVELOPMENT_REPORT_RU.md](DEVELOPMENT_REPORT_RU.md) for verified behavior and remaining integrations.

## AI Reply Guy

The integrated reply module is available at `/reply` in the dashboard or via `npm run reply:api`. See [REPLY_GUY_RU.md](REPLY_GUY_RU.md) for the plan mapping, official API credentials, Telegram, workers, deployment and verified limits. Migration 012 is additive and must be applied before enabling the module.

Migration 013 adds Reply Guy queue/tenant/budget/alert indexes. See DATABASE_PERFORMANCE_RU.md for measured fixture plans and deployment guidance.

Archive backfill/import and Solana datasets: see ARCHIVE_RU.md. Existing Playwright scraper remains in lib/trade/twitter-scraper.ts.

Сборщик браузера сохраняет снимки метрик и профилей, ссылки/упоминания/медиа и передаёт новые публикации в Archive. Неизвестные счётчики — NULL; migration 015 сохраняет старые нули без попытки восстановить их происхождение. Подробнее: [COLLECTOR_RU.md](COLLECTOR_RU.md).

## Запуск кнопкой

После настройки базы, MASTER_KEY, миграций и входа `npm run login -- main` запустите `npm start` и откройте http://127.0.0.1:3001/collector. Задайте запрос и нажмите «Начать парсинг»: worker запускается автоматически, прогресс и результаты обновляются. См. [COLLECTOR_RU.md](COLLECTOR_RU.md).

На странице парсинга есть SSE-мониторинг: сессии X, цели/авторы, этапы, найденные и сохранённые записи, нагрузка аккаунтов и ожидание. Нужна миграция 017. Подробности в COLLECTOR_RU.md.

## Bulk persistence and future AI analysis

Migration 018 adds immutable post versions, versioned model/results storage, and cutoff indexes. See AI_DATA_RU.md for reproducible JSONL export, the measured fixture benchmark, limitations and setup. Apply all migrations before restarting workers.

## Graph signals and autonomous monitoring v1

Apply migration 012 with `npm run migrate` inside x-collector before starting the scheduler.
`npm run monitor` runs one cycle; the scheduler runs it every five minutes. No new
AI, sentiment, embeddings, dashboard or trading features are used by this cycle.

The analyzer reads posts, entity mentions with confidence >= 0.5, explicit token
links and author reputation. Missing reputation contributes zero. It compares two
adjacent completed hourly windows. Duplicate tweets and repeated entity mentions
contribute once; author handles are normalized. Posts with missing timestamps and
future posts are excluded. Entity identifiers preserve type and value.

Base score: frequency (30), positive growth (30), unique authors (20), posting
velocity (20), each bounded. Final score = base * 0.60 + author reputation * 0.25
+ graph impact * 0.15. Graph impact combines author diversity (70%) and distinct
co-mentioned entities (30%). Scores are evidence of attention, not price predictions.
LOW <30; MEDIUM >=30; HIGH >=60; CRITICAL >=80.

History is stored in graph_signal_history. HIGH/CRITICAL observations also create
graph_priority_events with priorities 2/3. These are persisted events for consumers,
not externally delivered notifications. Transactional advisory locking serializes
cycles, REPEATABLE READ fixes the input snapshot, and unique keys deduplicate
entity/window records. Failed cycles roll back; successful windows remain immutable.
Late posts arriving after the first successful cycle are not retroactively included.

Inspect results with:
```sql
SELECT entity, bucket_at, score, level, payload
FROM graph_signal_history ORDER BY bucket_at DESC, score DESC LIMIT 100;
SELECT * FROM graph_priority_events ORDER BY priority DESC, created_at DESC LIMIT 100;
```

Real PostgreSQL integration check: set TEST_DATABASE_URL to a dedicated test database, then run `npm run test:db` inside x-collector. It creates and removes an isolated schema and checks persistence, duplicate protection, concurrent locking and rollback. Without TEST_DATABASE_URL the check is skipped.

The standard `npm test` also uses the embedded PostgreSQL engine PGlite to apply
the complete migration chain and verify actual SQL writes, deduplication,
rollback, and an injected failure during the event INSERT. This runs without an
external database; it does not verify concurrency between server connections.
The separate `test:db` check verifies that on PostgreSQL using two connections.
The admin X Collector explorer automatically lists both graph tables after migration
012, with Russian labels and explanations of scores and priorities.

GitHub Actions `X Collector monitoring` provisions PostgreSQL 17, checks the build, applies the full migration chain twice, runs the two-connection integration test, and executes the one-cycle monitor on an empty database. It uses disposable test credentials and does not access production.

The dashboard serves pinned Vue and Chart.js builds from local node_modules
(`/assets/vue.js`, `/assets/chart.js`); CSP is self-only with no external CDN
hosts, so no internet access is required. HTTP rate limits use the socket peer
address and ignore untrusted forwarded headers. Behind a reverse proxy, the
application limit is shared by requests from that proxy; configure per-client
limits at the proxy too.
