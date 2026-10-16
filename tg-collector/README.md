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

The security workflow runs GitHub dependency review on pull requests and high-severity production dependency audits for both `tg-collector` and `solana-launcher`.

### Environment template

`solana-launcher/.env.example` documents the local TG Collector variables. Secrets must be supplied through the local environment and are never exposed through `NEXT_PUBLIC_*` variables.

### Current repository policy

This repository is intentionally local-first for Telegram collection:

- one Telegram session;
- no automatic account rotation;
- public sources only;
- no invitation/join automation;
- observed facts are not interpreted as ownership, identity, or coordination.

