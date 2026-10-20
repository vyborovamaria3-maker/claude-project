# TG Collector (MVP)

Локальный Telegram-сборщик для проекта `claude-project`. Работает отдельным процессом Node.js на компьютере пользователя; не использует браузерную автоматизацию и не требует удалённого сервера. PostgreSQL должен быть доступен локально или по настроенному `DATABASE_URL`.

## Реализовано

- Авторизация собственного Telegram-аккаунта по MTProto через GramJS (код + 2FA).
- Локальное хранение сессии в `.tg-session` (права доступа 0600, файл исключён из Git).
- Добавление **публичных** каналов и групп по `@username` / `t.me/username`.
- Сбор доступной истории: ID сообщения, дата, текст, ID автора (если доступен), просмотры, пересылки и количество ответов.
- PostgreSQL-таблицы `tg_sources`, `tg_messages`, `tg_jobs`, `tg_runtime`.
- Идемпотентная запись `ON CONFLICT` по паре `(source_id, message_id)`.
- Инкрементальная синхронизация, снимок верхней границы, курсор по страницам и контрольная точка после **полного** сбора диапазона.
- Восстановление задания при истечении lease, повторные попытки для временных ошибок.
- Глобальная пауза при `FLOOD_WAIT`; обход ограничений Telegram не выполняется.
- PostgreSQL advisory lock запрещает запуск двух воркеров одновременно.
- На первой синхронизации собираются последние 500 сообщений (по умолчанию); более старые помечаются как `history_partial`.

## Запуск на Windows

Установите Node.js 22+, PostgreSQL, затем создайте отдельную БД `tg_collector`.

```powershell
cd claude-project\tg-collector
npm ci
Copy-Item .env.example .env
```

Заполните `.env`:

```env
TG_API_ID=123456
TG_API_HASH=YOUR_TELEGRAM_API_HASH
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/tg_collector
TG_SESSION_FILE=.tg-session
```

`TG_API_ID` и `TG_API_HASH` — для своего приложения на https://my.telegram.org. Не публикуйте `.env`, код авторизации, пароль 2FA или файл сессии.

```powershell
npm run migrate
npm run login
npm run add -- @durov
npm run worker
```

В отдельном терминале:

```powershell
npm run list
npm run typecheck
```

## Интерфейс в solana-launcher

После запуска `tg-collector` укажите **ту же самую БД** в файле `solana-launcher/.env.local`:

```env
TG_COLLECTOR_DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/tg_collector
```

В отдельном терминале:

```powershell
cd claude-project\solana-launcher
npm install
npm run dev
```

Откройте `http://localhost:3000/tg-collector` (пункт меню **рядом с TGInvite**) или `http://localhost:3000/settings` → **TG Collector**. Здесь доступны:

- счётчики каналов, сообщений и ошибок;
- проверка heartbeat локального воркера и FloodWait;
- добавление публичных `@username`;
- постановка синхронизации в очередь, повтор, пауза/возобновление, удаление;
- просмотр сообщений, фильтр по источнику, текстовый поиск и постраничный вывод;
- интерактивный граф упоминаний, пересылок и адресов с переходом к сообщениям-основаниям;
- аналитика активности каналов за 7 и 30 дней;
- пересечения источников по общим адресам и даты первых наблюдений адресов в собранных данных.

Кнопка «Пауза» не останавливает уже запущенный сетевой запрос; после его завершения воркер приостановит следующие страницы. Секреты Telegram никогда не передаются через браузер — авторизация выполняется в терминале.

**Локальная защита:** API `/api/integrations/tg-collector` доступен только через `localhost` в dev-режиме и отключён в production, поэтому не выставляйте dev-сервер в интернет. Для удалённого доступа необходимы отдельные аутентификация и контроль разрешений.

Для запуска проверок:

```powershell
cd claude-project\tg-collector
npm run typecheck
npm test
npm run analyze:backfill
```

## Аналитическая модель и происхождение связей

Данные разделены на независимые слои:

```text
src/accounts/session.ts          авторизация GramJS и локальная сессия
src/queue/jobs.ts                claim, delay, lease, recovery
src/engines/channel.ts           чтение канала и контрольные точки
src/persistence/messages.ts      атомарная запись сообщений и evidence
src/persistence/pages.ts         запись страниц истории
src/analytics/extract.ts         извлечение типов и идентификаторов связей
src/analytics/backfill.ts        пересчёт уже загруженной истории без Telegram
src/monitoring/heartbeat.ts      телеметрия воркера и FloodWait
src/runtime/config.ts            конфигурация и лимиты
src/runtime/worker-loop.ts       главный цикл и graceful stop
src/worker.ts                    совместимая точка входа npm run worker
src/telegram.ts                  совместимый re-export авторизации
sql/002_analytics.sql            нормализованные evidence-связи
solana-launcher/.../graph        API графа, исходных доказательств и сводок
solana-launcher/.../TGGraphPanel.tsx   визуализация и фильтры
```

- **Пересылка**: идентификатор исходного канала есть в Telegram-метаданных `fwdFrom.fromId.PeerChannel`. Анонимный `fromName` намеренно не превращается в идентичность.
- **Упоминание**: в тексте есть `@username` или публичная ссылка `t.me/username`. Это не подтверждение участия или владения.
- **Адрес**: текст содержит строку валидного Solana-адреса или адреса EVM-формата. Это не подтверждение, что адрес — контракт токена, торговый кошелёк или связанный с автором актив.
- **Граф**: ребро всегда имеет `(source_id, message_id, kind, target)`, а детализация показывает сообщения-основания. Одна публикация учитывается для каждого конкретного target однократно. Межканальные совпадения представлены через общий адрес/handle, без выдуманного причинного ребра.
- **Пересчёт**: `npm run analyze:backfill` восстанавливает связи из уже собранного текста, идемпотентно и без повторной загрузки Telegram. Метаданные пересылок, не сохранённые ранее, восстановить из текста невозможно.
- **Неполнота**: удалённые/изменённые старые сообщения и пропуски первого сбора могут исказить агрегаты. Среднее просмотров — срез счётчиков, не число подписчиков и не настоящая вовлечённость.

## Тестирование и проверка схемы

CI `TG Collector checks` запускает `npm run typecheck`, чистые тесты извлечения и интеграционный тест с PostgreSQL 16. Интеграционный тест проверяет миграции, повторную запись без дублей, удаление устаревших связей при обновлении сообщения и удаление источника по FK cascade. Скрипт `npm run analyze:backfill` выполняется отдельно при переходе со старой схемы.

CI не проверяет живую авторизацию MTProto, ограничения Telegram или полноту истории; для этого нужен личный тестовый аккаунт и публичный тестовый канал.

## Защищённый локальный интерфейс и миграции

В `solana-launcher/.env.local` добавьте:

```ini
TG_COLLECTOR_DATABASE_URL=postgresql://postgres:password@127.0.0.1:5432/tg_collector
TG_COLLECTOR_ADMIN_TOKEN=your-unique-random-key-at-least-24-characters
```

Создайте собственный случайный ключ, например в PowerShell:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Не копируйте пример ключа и не добавляйте реальный ключ в Git. Запускайте интерфейс на ноутбуке через
`cd solana-launcher; npm run dev:local`, затем откройте
`http://127.0.0.1:3000/tg-collector` и введите этот ключ. Он хранится только в памяти вкладки.
API отклоняет запросы без ключа, требует совпадения Origin для изменения источников и
недоступен в production. Основной `npm run dev` может слушать внешние интерфейсы, поэтому
для локальной панели используйте только `dev:local`.

`npm run migrate` применяет схему транзакционно с блокировкой конкурентных миграций.
Старые задания-дубликаты архивируются в `tg_jobs_dedup_archive`; оставшееся задание заново
синхронизируется от последней подтверждённой контрольной точки. Миграция 006 подключает
`pg_trgm` для ускорения поиска `ILIKE`: учётная запись PostgreSQL должна иметь
права на создание доверенного расширения и индекса.

После первого перехода на дневные агрегаты выполните с остановленным воркером:

```powershell
npm run migrate
npm run analyze:backfill
npm run analyze:refresh
```

Миграция 007 добавляет точные счётчики `tg_source_message_counters`:
при повторном сохранении одного сообщения счётчик не увеличивается, а при удалении
уменьшается триггером. При первом применении миграции накопленная история подсчитывается
один раз; далее панель читает счётчики без группировки миллионов сообщений.
Новые метрики 7/30 дней основаны на таблице `tg_source_daily_metrics`.

`analyze:refresh` пересчитает дневные связи, публикации и снимки просмотров за
прошлые периоды. Дальше метрики обновляются одновременно с записью новых страниц.
Продакшн-аудит исключает dev-only маршрут `/tg-collector`, где ожидаем 404;
его работоспособность нужно проверять отдельно в локальном режиме.

## Проверки перед слиянием — изменения после ревью

**Нормализация.** `src/analytics/normalize.ts` создаёт единый ключ для `@handle`, `t.me/handle` и ссылок на публичные сообщения; для EVM адресов требуется полный `0x` + 40 hex символов и сравнение по lower-case; Solana base58 сохраняет регистр и проверяется на 32 байта. Обрезки `0x123...` и отсутствующие префиксы не угадываются.

**Источники пересылок.** Для GramJS используем только `fwdFrom.fromId.PeerChannel`, для будущего Bot API адаптера принимаем только подтверждённое `forward_from_chat` типа channel/supergroup. `forward_sender_name`, `fwdFrom.fromName` и `forward_from` пользователя не превращаются в подтверждённые идентичности.

**Уникальность связей.** PK `tg_message_links(source_id,message_id,kind,target_kind,target_key)` гарантирует максимум одну связь данного типа с целью из одного сообщения. Граф агрегирует связи, но исходные сообщения остаются независимыми доказательствами. При удалении одного сообщения FK CASCADE удаляет только его собственные наблюдения; другие сообщения остаются. Осиротевшие рёбра без первоисточника сознательно не создаются.

**Предрасчёт графа.** `tg_graph_daily_edges` хранит агрегаты по source + UTC-day + kind + target. Обновляются в транзакции записи страницы; граф, пересечения и лидирующие адреса читают агрегаты. Для восстановленных старых сообщений запустите `npm run analyze:backfill`, для полной перестройки кэша (например, после ручного удаления строк) — `npm run analyze:refresh`. Во время обеих офлайн-команд основной воркер должен быть **остановлен**. Если сообщение не имеет `posted_at`, его связь сохраняется как первичный факт, но не входит в датированные сводки.

**База времени.** `tg_messages.posted_at` — время публикации, полученное из `message.date` Telegram. `collected_at` — время записи для операционного контроля. Периоды графа — **календарные дни UTC**. Первое наблюдение — только в доступной собранной истории, не первое появление адреса в интернете.

**Повторные попытки.** `src/queue/retry.ts`: FloodWait → глобальная пауза, SLOWMODE_WAIT → задержка конкретной задачи, PeerFlood → остановка аккаунта, отозванная сессия → остановка до повторного логина, временные ошибки → ограниченные retries. Автоматической смены/ротации аккаунтов нет. Состояние блокировки отображается в панели. После снятия ограничений Telegram пользователь может явно снять блокировку локальной командой:

```powershell
npx tsx src/cli.ts unblock --i-confirm-restriction-cleared
```

**Живой MTProto smoke-test (только на своём ноутбуке).** Сначала остановите `npm run worker`, убедитесь, что есть авторизованная тестовая сессия и тестовая PostgreSQL БД. Запустите:

```powershell
npm run migrate
npm run login
npm run smoke:mtproto -- @public_test_channel
```

Скрипт читает максимум 100 доступных сообщений, записывает их в ту же БД и сверяет число прочитанных/записанных сообщений. Сверьте выведенные `message_id` и образцы пересылок/упоминаний в Telegram вручную. Скрипт **не** доказывает полную историю и не выполнялся в рамках CI без аккаунта. Не используйте основной личный аккаунт для тестов, не публикуйте session/2FA/API hash.

**CI:** автоматические проверки `npm run typecheck`, `npm test` (включая PostgreSQL 16) и сборка фронтенда. Переход на `main` — только после успешных проверок и реального smoke-прогона на локальной машине.

## Важные границы MVP

- Сбор только из публичных каналов/групп, доступных авторизованному аккаунту. По ссылкам-приглашениям автоматически не вступает.
- **Нет** массового инвайтинга, обхода банов, выгрузки скрытых участников или приватных переписок.
- Сейчас используется **одна сессия Telegram** на воркер. Управление несколькими аккаунтами — отдельный следующий этап. Локальные API Next.js и UI подключены.
- Последующие изменения/удаления **старых** сообщений не отслеживаются: инкрементальный проход получает новые сообщения. Медиафайлы не скачиваются.
- История сообщений может быть неполной из-за лимита начальной загрузки и ограничений видимости Telegram; это явно отмечается `history_partial`.
- В CI используется отдельная PostgreSQL БД и проверяются миграции/целостность связей. Живой MTProto E2E без локальной тестовой сессии Telegram пока не проверен.

## Схема обработки

```text
Public channel -> TG source -> tg_jobs claim -> GramJS MTProto
                                        |         |
                                        v         v
                                   checkpoint  FloodWait
                                        |         |
                                        v         v
                                   tg_messages  global pause
```

## Следующий этап

1. Провести на ноутбуке живой MTProto smoke на 100 сообщениях и ручную сверку ссылок на сообщения.
2. Открыть `/tg-collector` локально, проверить граф на реальных тестовых данных, клик на ребро и список сообщений-оснований.
3. Добавить отдельную ончейн-валидацию адресов Solana/EVM: текстовое упоминание адреса само по себе не определяет тип актива, владение, доходность или участие автора в транзакциях.
4. После стабилизации графа добавить отдельные агрегаты для больших объёмов статистики и отслеживание изменений/удалений уже собранных сообщений.

Проверки без `DATABASE_URL` запускают модульные тесты и явно пропускают два теста PostgreSQL. Для проверки миграций и транзакций задайте URL отдельной тестовой БД; её данные могут изменяться. CI устанавливает точные зависимости через `npm ci`.

### Проверка переходов в графе

Запустите локальный dev-сервер solana-launcher на 127.0.0.1:3171, затем из его каталога выполните `node tests/tg-collector-graph-smoke.mjs`. Другой локальный адрес задаётся через `TG_COLLECTOR_SMOKE_URL`.
Проверка использует синтетические ответы API: выбор связи → сообщения-основания → корректный URL исходного поста; при переключении связи старые основания должны исчезнуть до завершения следующего запроса. Она не обращается к Telegram и не заменяет `smoke:mtproto`.

## Operational hardening

### Canonical evidence version

`tg_message_links.analysis_version` records the extractor version that created each observed fact. The current extractor is `ANALYSIS_VERSION=2`.

Backfill continues to use `tg_messages.analysis_version` as the message-level work marker, while the link-level version preserves provenance for each canonical fact. If an old forward is intentionally preserved because Telegram no longer exposes its original header, its link keeps the older analysis version instead of being falsely re-labelled as freshly observed.

### Graph limits

The graph API defaults to:

- 500 nodes
- 2,000 edges
- edge offset 0

The server reports `truncated`, the applied limits, and `nextEdgeOffset`. Clients may request a smaller bounded page with `nodeLimit`, `edgeLimit`, and `edgeOffset`; the API never accepts more than 500 nodes or 2,000 edges per response.

The UI may additionally clip the rendered SVG for readability. That client-side clipping is separate from server-side truncation.

### Evidence semantics

For each daily graph edge:

- `evidence_count` = number of canonical `tg_message_links` facts for that source/message/target/day.
- `message_count` = number of distinct source messages supporting the edge in that day.
- Because canonical links are unique on `(source_id,message_id,kind,target_kind,target_key)`, these counts are equal for a normal edge.
- `sample_message_id` is selected only from active messages when rollups are rebuilt.

All analytical dates use Telegram `posted_at` converted to UTC. `inserted_at/collected_at` is operational metadata and is not used for 7/30/90-day analytics.

### Deleted messages

Messages use `tg_messages.deleted_at` as a soft-delete marker.

A deleted message is excluded from:

- active message search;
- message counters;
- graph rollups after the affected day is rebuilt;
- evidence lookup in the UI.

Its `tg_message_links` rows are retained so canonical provenance is not silently destroyed. `markMessageDeleted()` updates the counter and rebuilds the affected UTC day in the same transaction.

There is intentionally no heuristic that declares a message deleted merely because a later Telegram history page did not return it. Telegram history gaps are not proof of deletion. A future deletion detector must call the lifecycle helper only when Telegram provides a reliable deletion signal.

### Runtime metrics

`tg_runtime` exposes these explicit operational metrics:

- `messages_total`
- `messages_per_day`
- `links_total`
- `links_per_day`
- `jobs_pending`
- `jobs_failed`
- `flood_wait_active`
- `metrics_updated_at`

The heartbeat refreshes these every five seconds. Message totals use the maintained per-source counters; link totals use a maintained runtime counter; daily values use the daily rollup tables rather than scanning the entire message/link history.

### Worker concurrency

The worker already takes the session-level PostgreSQL advisory lock `8260226`. A second worker exits instead of sharing the same Telegram session.

Queue claiming remains `FOR UPDATE SKIP LOCKED`, so two consumers cannot claim the same job. The integration suite contains a two-consumer regression test.

### Backups and retention

Run:

```bash
npm run backup
```

The script creates a PostgreSQL custom-format archive under `TG_BACKUP_DIR` (default `./backups`), verifies it with `pg_restore --list`, writes a SHA-256 checksum when the platform provides `sha256sum` or `shasum`, and removes local archives older than `TG_BACKUP_RETENTION_DAYS` (default 7).

Optional off-host replication can be enabled with `TG_BACKUP_RCLONE_REMOTE`. The script uses `rclone copy`; the remote itself must be configured outside Git.

Non-destructive archive validation:

```bash
npm run backup:verify -- ./backups/tg-collector-YYYYMMDDTHHMMSSZ.dump
```

The custom PostgreSQL format is compressed and designed for `pg_restore`. A real restore test must target a disposable database; `restore-check.sh` never mutates the source database.

**Do not commit `backups/*.dump`, session files, tokens, or database credentials.**

Monthly partitioning of `tg_messages` is deliberately deferred. The current primary key and foreign-key provenance model are not changed casually: partitioning by `posted_at` requires a dedicated key/FK redesign and a rehearsed migration. Until that migration exists, monitor table growth and keep verified off-host backups.

### Deterministic Telegram fixtures

`tests/fixtures/telegram/messages.v1.json` is the stable parser fixture contract. It records `fixture_version` and `gramjs_version`, and serializes bigint-like Telegram IDs as strings.

Unit tests must use these fixtures or equivalent deterministic objects. The live `smoke:mtproto` command remains separate and is the only test that requires a real Telegram session and a public test channel.

### Frontend/API security

The Next.js collector routes use the Node.js runtime because they access PostgreSQL. They remain local-only and require `TG_COLLECTOR_ADMIN_TOKEN`.

`tgCollectorAccess.ts` applies:

- localhost host validation;
- same-origin validation for mutations;
- constant-time token comparison after hashing;
- per-IP/per-token in-memory rate limiting;
- 120 read requests/minute or 30 mutation requests/minute per bucket.

The rate limiter is an abuse-control layer, not a replacement for localhost binding or authentication.

The frontend has its own CI workflow:

- ESLint;
- access guard tests: missing token -> 401, wrong token -> 401, correct token -> success, abusive caller -> 429;
- production build.

The security workflow runs high-severity production dependency audits for both `tg-collector` and `solana-launcher`. GitHub Dependency Review is intentionally not used because the repository Dependency graph feature is not enabled for this repository connection; the existing repository-wide Security Gates workflow remains the source of truth for its broader secret/security scans.

### Environment template

`solana-launcher/.env.example` documents the local TG Collector variables. Secrets must be supplied through the local environment and are never exposed through `NEXT_PUBLIC_*` variables.

### Current repository policy

This repository is intentionally local-first for Telegram collection:

- one Telegram session;
- no automatic account rotation;
- public sources only;
- no invitation/join automation;
- observed facts are not interpreted as ownership, identity, or coordination.


Тестовые файлы выполняются с `--test-concurrency=1`, поскольку интеграционные сценарии используют общую БД и повторно применяют DDL миграций. Проверка конкурентного `FOR UPDATE SKIP LOCKED` внутри отдельного теста остаётся параллельной.


## Управление из панели

В solana-launcher/settings вкладка TG Collector позволяет:

- запускать и останавливать глобальный сбор;
- добавлять публичные каналы/супергруппы в очередь;
- ставить отдельный источник на паузу, возобновлять и синхронизировать;
- видеть состояние worker, FloodWait, ошибки и основные метрики;
- просматривать сообщения и граф связей;
- настраивать Telegram proxy.

В админке доступны те же операции на /admin/tg-collector; переключатель X Collector / TG Collector находится рядом с существующим X Registry.

### Proxy

Поддерживаются SOCKS5, SOCKS4 и MTProto, которые поддерживает Node-режим GramJS. HTTP proxy намеренно не принимается.

Поля логина/пароля/secret не возвращаются в браузер. Они шифруются AES-256-GCM перед записью в tg_proxy_config. Для ключа шифрования рекомендуется задать TG_PROXY_ENCRYPTION_KEY; если он не задан, локально используется TG_API_HASH как источник ключа.

После изменения proxy нужно перезапустить worker: TelegramClient создаётся с proxy при подключении. Для проверки из панели кнопка «Проверить порт» проверяет TCP-доступность host:port; это не подменяет полноценный Telegram handshake. Route Handler работает в Node.js runtime, поэтому TCP-проверка выполняется на серверной стороне.


### Review corrections (2026-10-16)

- Stop and source pause take effect before the next Telegram page; an in-flight page is committed with its cursor. Claims also check global enable/block/FloodWait state.
- Start/resume preserve delayed retry deadlines. `jobs_pending` counts pending/delayed jobs separately from running jobs.
- SOCKS transport deliberately omits the `MTProxy` property: GramJS checks property presence, not its boolean value. Login uses the configured proxy too.
- Blank credentials preserve existing values only for the same host, port and protocol. Changing the endpoint requires entering its credentials again. Password whitespace is preserved.
- The web process and worker must use the same `TG_PROXY_ENCRYPTION_KEY` (or the same fallback `TG_API_HASH`). Proxy changes require a worker restart.
- `analyze:refresh` excludes soft-deleted messages and rebuilds `message_count`. Additive migration 010 repairs active counters once and prevents double decrement when a soft-deleted row is purged.
- A lost singleton-lock connection terminates the worker immediately, preventing a replacement worker from racing with an old page write.
- The localhost access check uses the validated browser Host authority, handling Next.js internal normalization of 127.0.0.1 to localhost while retaining same-origin enforcement.

The global history scanner also sees obsolete branches. The two historical tginvite test files are absent from this branch and main. Only the exact SHA-256 of their synthetic alphabet fixture is ignored in history for those paths; current/diff scans and other historical tokens remain strict. No repository history was rewritten.


### Trusted local browser session

To connect Settings and Admin without retyping the access key, set `TG_COLLECTOR_LOCAL_AUTO_CONNECT=1` and `TG_COLLECTOR_LOCAL_ORIGIN` to the exact loopback browser origin in the frontend environment. Keep `TG_COLLECTOR_ADMIN_TOKEN` configured on the server. The browser requests an origin-bound, signed HttpOnly cookie; it never receives the server token or Telegram credentials. Bootstrap requires a same-origin browser POST, and the existing host/origin/rate checks apply to API operations. Automatic connection remains disabled in production and by default. Both panels use the worker database configured by `TG_COLLECTOR_DATABASE_URL`, with the matching proxy encryption key.

Optional live UI verification: `TG_COLLECTOR_SMOKE_URL=http://127.0.0.1:3100 node tests/tg-collector-local-smoke.mjs` from solana-launcher. It checks real stored messages, HttpOnly access, cross-origin rejection, and stopping in Settings then starting in Admin; it leaves collection enabled.


## Solana memecoin intelligence (migration 011)

The Telegram collector now stores Solana-looking addresses as **candidates**, not as confirmed tokens. A base58 string in a post may be a wallet or another account; it is only promoted to `tg_tokens` after the configured Alchemy Solana RPC confirms an initialized SPL Token / Token-2022 mint account.

Set `ALCHEMY_SOLANA_RPC_URL` in `tg-collector/.env` to your Alchemy HTTPS RPC endpoint. Do not commit the endpoint if it embeds a private API key. Then run:

```powershell
npm run migrate
npm run analyze:backfill -- --batch-size=1000
npm run tokens:resolve -- --limit=100
npm run market:refresh -- --limit=100
npm run market:outcomes -- --limit=500
npm run analyze:refresh
```

- `tg_token_candidates` stores unresolved address/cashtag observations and provider resolution status.
- `tg_tokens` identifies a token by `(chain_id, mint)`; symbol/name are metadata, not identity.
- `tg_ticker_registry` keeps confirmed/probable/unresolved ticker mappings. A ticker is not linked automatically unless one explicit cashtag appears with a provider-verified mint in the same message.
- `tg_token_mentions` contains only resolved token mentions and preserves the source message and analysis version.
- `tg_token_first_mentions` means earliest in the currently collected history, not proof of the earliest public Telegram post. Source-history completeness is recorded separately.
- `tg_copy_clusters` uses normalized exact fingerprints as a deterministic first pass. It deliberately ignores very short posts; near-duplicate semantic similarity and bot attribution are not claimed by this pass.
- `tg_token_velocity` and `tg_channel_metrics_daily` are derived aggregates. `tg_channel_scores` keeps discovery, outcome, originality and risk components separate; the composite remains NULL until at least five complete outcomes exist.
- `tg_token_market_snapshots` stores timestamped DexScreener observations with provider and quality metadata. A current snapshot is not historical price data. If no snapshot exists close to a message timestamp, `tg_token_outcomes` records insufficient data instead of inventing a price.
- `tg_signals`, narrative/propagation tables and backtest tables preserve versioned, reviewable results. Similar messages are evidence of similarity, not proof of coordinated behavior.

Migration files are immutable after being applied: `schema_migrations` stores SHA-256 checksums and startup refuses edited applied SQL. Retention policies are registered but disabled by default; no data is deleted automatically until an explicit retention schedule is configured. Monthly partitioning is deferred until the composite keys and foreign-key design are migrated and rehearsed safely.


### Public crypto source discovery

Control Center → TG Collector → Автопоиск configures keywords, enable/disable,
interval (15–1440 minutes), results/query (1–50), queries/cycle (1–10), requests/day
(1–200), new sources/day (1–100), and maximum total stored sources (1–1000).
Defaults: hourly, one query, 10 results, 24 requests/day, 3 new sources/day, 30 total.
Migration `016_source_discovery.sql` leaves discovery disabled until the operator enables it.
The local rollout explicitly enables crypto/memecoin defaults in the admin UI.

The singleton worker calls Telegram contacts.Search sequentially using its existing
collector session and proxy. Telegram search is relevance-ranked and not an exhaustive
Telegram directory. Only public Channel entities (broadcast or megagroup) with a valid
username are eligible. No joining chats, private chat scanning or messages to users occur.
A discovered source and its initial collection job are committed together. The normal
collection settings (initial 500 messages, incremental polling) apply to added sources.

Request and source budgets persist across restarts and reset at UTC midnight.
Global Stop, FloodWait and account/session blocks also stop discovery. Keyword rotation
is durable. Paused sources remain paused; source deletion leaves a discovery tombstone
so the worker cannot silently recreate it. Changes to configuration invalidate in-flight
results before new sources are connected. Disabling discovery preserves existing sources
and their history; they remain subject to the ordinary collection controls.

Automatic keywords (migration `017`) are enabled by default when discovery is enabled.
Set `TG_DISCOVERY_TWITTER_DATABASE_URL` privately to the existing Twitter PostgreSQL
source. The worker reads up to 2000 posts from the last 72 hours in a read-only
transaction, then ranks crypto topics, cashtags and hashtags. Defaults require three
unique posts and two authors, with up to 12 keywords. Duplicate posts, generic promo
terms and addresses are excluded. Limits and thresholds are editable in the admin.
Only keyword/count summaries are stored; no Twitter credentials or post copies are
exposed. Manual keywords remain an optional fallback if the source is unavailable.
The existing Telegram daily budgets and global Start/Stop still apply.

### Pump.fun mint/ticker discovery

Admin discovery settings optionally enable Pump.fun candidates, with up to ten explicit
mint addresses or tickers (case-sensitive mints preserved). Empty inputs use Pump.fun
mint mentions and ranked words from the Twitter sample. Each cycle performs at most
1–10 bounded metadata queries (default 3). Only tokens with provider-reported historical
`ath_market_cap` at or above the configured USD threshold (default 100000) generate
Telegram queries; current capitalization is never substituted for missing ATH.
The UI exposes eligible mint/symbol/ATH summaries and a sanitized provider error.
This is bounded candidate discovery, not a complete historical token universe or a
recommendation. Telegram contacts.Search searches public source names; finding every
channel that mentioned a mint is not guaranteed. The existing message search accepts
mint addresses/tickers for messages already collected. Pump.fun access can return 403;
in that case Pump candidates remain empty and normal Twitter discovery continues.


Pump.fun HTTP 403 now triggers an independent fallback: DexScreener resolves an exact
Solana ticker, CoinGecko verifies the exact Solana contract and Pump.fun category,
then provides 90-day historical USD `market_caps`. Only completed historical days
count. A recorded capitalization above the configured threshold proves that the
all-time high was at least that high; this bounded maximum is explicitly labeled
as a historical lower bound, not an exact lifetime ATH. Current market cap, FDV and
ATH price multiplied by today's supply are never substituted. Unlisted assets or
missing history cannot qualify. Results retain provider, date and coverage metadata.
Positive lookups cache for six hours, no-data for one hour and failures for 15 minutes;
Pump 403 also backs off the primary for six hours in the running worker. A cycle has
a 20-second lookup deadline. CoinGecko availability/rate limits still apply.
Live mint and ticker PNUT both resolved the same verified Pump.fun contract and a
historical capitalization of approximately $57.84M (2026-09-23), exceeding $100k.


### Public post discovery and complete channel/discussion history

Enable message search in the native admin and configure separate ticker, name and
case-sensitive mint terms. `channels.searchPosts` full text requires Premium/free
quota on Telegram; Stars payment is never authorized. Access failures are explicit.
When unavailable, the worker uses public hashtag search and broadcast-only
`messages.searchGlobal` for accessible public results, plus exact term matching in
collected history. These modes have different coverage and are not an all-Telegram
census. RPC pages share persistent request budgets and term-specific offsets.

The admin separates unique observed public messages (peer/message ID deduplication)
from distinct sources and connected-source mentions. Repeated query variants merge
matched terms. Message previews include public post links; response counts for
individual Telegram queries are not summed into a fabricated global count.

A matching source opts into full available history rather than the initial 500-post
cutoff. Existing page checkpoints continue across jobs/restarts, with bounded pages
per job and the shared queue. Public linked discussion groups are resolved without
joining chats and queued within the same source budgets; private/unavailable groups
remain explicit. The last source-budget slot is reserved for discussion groups when
there is capacity. Existing source pauses/deletion tombstones and global Stop remain
in force. History completion means all history accessible to this account was read,
not private/deleted posts. Reactions (emoji/custom ID and counts), views and replies
are stored as observed; the latest 20 messages refresh engagement on each source poll.

The available-index fallback uses broadcast-only searches and rejects private/user
results before storage. If the hashtag response is unavailable, it also falls back
to that index; this is explicitly labeled limited coverage, not a Premium bypass.
Complete-history sources yield after at most two pages per queue turn so discovery,
other sources and Stop remain responsive. Engagement observations are timestamped;
legacy reaction snapshots remain unknown until fetched rather than displayed as zero.


### Expanded discovery without Premium

The optional external search reads bounded public `t.me/s/<channel>?q=<term>` pages,
links in matching Twitter database posts and links inside verified Telegram posts.
Editable initial public channel/group seeds bootstrap a durable candidate queue;
external links and snippets never count as mentions. Each candidate is resolved via
Telegram, must be a public Channel/supergroup, and its actual posts must match the
configured ticker/name/mint terms. Public preview post IDs are fetched in one batch;
public groups without previews use ordinary per-channel message search, not paid
global search. Invite links, bots and private/user results are excluded. No joining,
verification-bot interaction or Stars payment occurs.

Defaults are one candidate page per cycle, 24 pages/day (two Telegram RPC slots
reserved per page), up to 20 posts/page and a 500-candidate queue. Page/term offsets,
verification provenance and daily budgets persist across restarts. Existing source
budgets, pauses, deletion tombstones, Stop and FloodWait remain effective. Verified
public groups may use the final reserved source slot. Verified sources feed the same
full-history queue. Admin separately reports externally verified unique posts and
sources; these are a subset of overall mentions and never an all-Telegram total.

Public groups linked inside a verified matching post may also be connected after
Telegram confirms public identity and readable history. Their unrelated messages
are never counted as token mentions. The candidate retains the originating public
post URL, and the admin marks these as related public groups rather than matched
posts. No join or verification-bot step is attempted.


## Full channel history (opt-in)

The default `npm run add -- @public_channel` keeps the initial collection bounded to the latest
`TG_INITIAL_MESSAGE_LIMIT` posts (500 by default), and reports incomplete history. To collect
all Telegram-accessible older posts instead:

```bash
npm run add -- @public_channel --full
npm run history -- @existing_channel
```

You can also select **«Вся история»** while adding a source in Settings → TG Collector, or
click **«Собрать всю историю»** for an existing source. The admin panel shares the same UI.

Full historical scanning is incremental and can require many worker turns. The collector keeps
`tg_sources.history_low_message_id` (lowest saved message ID) and the job cursor to resume
across restarts. A short page does **not** prove Telegram history is exhausted; the historical
scan completes on an empty page. `history_complete` means the collector exhausted the
**accessible** history, not that all ever-published posts remain accessible.

After upgrading an existing database, **stop the TG worker** and run:

```bash
npm run backup
npm run migrate
npm run analyze:backfill
npm run analyze:refresh
npm run worker
```

The new v4 extractor also finds URLs from Telegram `MessageEntityTextUrl` entities, which
may be hidden behind a text label; these entities and selected forward/media metadata are
retained with each message. For a real Telegram check use a disposable local database and
`npm run smoke:mtproto -- @your_test_channel`; this compares Telegram fields and evidence,
then replays the batch to verify idempotency. It still cannot certify complete channel history
without independent observation. Never check in a Telegram session or proxy credentials.


### Channel identity and evidence counters

The original `tg_sources.identifier` is a stable operator-entered alias. A channel's
Telegram ID (`peer_id`) is pinned after first resolution, and `current_username` is
refreshed from the verified Telegram entity for public links in Settings and the graph.
If the old username is reused by a different channel, that new channel is **not**
substituted into the old source's history. A stored access hash is used only to recover
the original channel while it still exposes a public username; private-channel
collection is intentionally rejected.

The runtime now reports two different counts:
- `links_total`: all retained canonical evidence, including orphaned historical records;
- `links_active_total`: currently active, non-orphaned evidence.

Migrations `025_active_link_metrics.sql` and `026_current_public_username.sql` are
additive; the former initializes exact active link counts and keeps them updated
transactionally on inserts, deletes, and soft-deletion status changes.

Enabling full history will **not** move jobs currently delayed by Telegram forward in
time. Their existing `run_at` and page checkpoint remain intact until the delay ends.

### Safe rollout for PR #138 follow-up fixes

The source identity migration `027_source_peer_identity.sql` refuses to run if
two preexisting `tg_sources` rows share the same confirmed `peer_id`. **Do not**
delete either source automatically: compare messages and evidence, reconcile in
a disposable backup and retry the migration. Old username aliases are not
authoritative. The Worker also refuses to silently overwrite a different
source's Telegram ID.

**Legacy identity preflight.** Sources collected before verified peer IDs existed
may still have `tg_sources.peer_id IS NULL` even though their histories contain
messages. Those rows now fail closed with `TG_SOURCE_IDENTITY_UNVERIFIED` when
Telegram resolves the original username but no independently verified discovery
mapping confirms the peer. This is intentional: a username can have changed
owners since the archive was collected. The worker does not overwrite the old
messages or guess a peer ID. Before restarting the worker, inspect:

```sql
SELECT s.id, s.identifier, s.last_message_id, s.history_low_message_id,
  (SELECT count(*) FROM tg_messages m WHERE m.source_id=s.id) AS stored_messages
FROM tg_sources s
WHERE s.peer_id IS NULL
  AND (s.last_message_id > 0 OR s.history_low_message_id > 0
       OR EXISTS(SELECT 1 FROM tg_messages m WHERE m.source_id=s.id))
ORDER BY s.id;
```

For any result, review the original archive and independently confirm the
Telegram channel ID before changing source identity. Never bulk-assign
`peer_id` from the current username alone; an identity conflict needs manual
reconciliation on a backed-up database. The MTProto smoke test similarly refuses
to reuse existing unverified archives or attach posts to a conflicting peer.

The new-message collector uses a separate durable `tg_jobs.fresh_*` checkpoint
while it continues scanning an older history interval. It checks for recent
posts approximately every 30 seconds and prioritizes those posts without
advancing the historical cursor. Neither side ignores FloodWait or source
pauses. Migration `028_live_while_backfill.sql` adds these checkpoint fields.

Previously collected text has `entities_observed_at=NULL`, even when the
migrated default `entities=[]` is present. That means **hidden URLs may be
missing**, regardless of `history_complete`. Migration
`029_entities_coverage.sql` and the UI expose this as separate evidence
coverage. To restore it on a **local laptop only**, stop the TG Worker, back up
the database, run migrations, then issue bounded refetch batches:

```bash
npm run entities:refetch -- @public_channel --limit=200
```

This command uses the existing authorized Telegram session, validates the
immutable peer ID, rejects private-source collection, acquires the singleton
worker lock, and re-fetches original message IDs in batches. Missing/deleted
posts remain unverified. Do not assume a successful offline backfill can
recover Telegram entities that were never originally stored.

Version-4 backfill reuses mints already confirmed in `tg_tokens`, and
unambiguous confirmed ticker associations. This avoids paying again to
verify the same Solana mint. **New** addresses still require explicit
`npm run tokens:resolve` with configured Alchemy RPC, if you choose to
verify them. Finish with `npm run analyze:refresh` to rebuild derived
scores and first mentions. The project does not issue those paid requests
automatically during migrations.

Recommended safe order: local backup → stop Worker → migrate → backfill →
optional entity refetch → optional tokens:resolve → analyze:refresh →
restart Worker → run live smoke on a disposable PostgreSQL database.
