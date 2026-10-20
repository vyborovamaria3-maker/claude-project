# ARCH-08 — ограниченный исторический backfill исходных доказательств

**Состояние:** подготовлено для изолированных тестов; не применено к реальным базам. Draft PR #138 поверх #137 → #136 → #135 → #134 → #133. Не путать с уже существующим `x-collector/scripts/intelligence-backfill.ts`, который повторно индексирует *внутренние raw наблюдения X*, а не наполняет межсистемный source Outbox.

## Что переносится (и что категорически не переносится)

| Источник | Читаем | Создаём в ИСХОДНОМ Outbox | Не утверждаем |
| --- | --- | --- | --- |
| X PostgreSQL | `twitter_tweets.tweet_id`, стабильный `author_id`, `updated_at`, `posted_at` | `tweet_observed` с `x-backfill-snapshot-v1` и автором | Новый токен/mint, первая версия текста, восстановленное историческое наблюдение |
| TG PostgreSQL | ТЕКУЩИЙ неделетированный снимок `tg_messages`, `tg_sources.peer_id`, `collected_at` | `message_observed` с `tg-backfill-snapshot-v1` и каналом | Событие удалённого сообщения, историческая правка, ticker/mint идентичность |
| Blockchain SQLite | `chain_seed_events` только `kind='wallet'`, валидные signature/wallet/payload_hash и **сохранённые** `block_time`, `observed_at` | `wallet_transaction_observed` через **существующий** native event builder | Подтверждённый swap, on-chain mint из целевого адреса, PnL, finalized/полнота истории |

События создаются только из уже сохранённых доказательств. Ни XActions, ни Telegram MTProto, ни Helius, ни Alchemy не вызываются. Закрытые/неизвестные наблюдения не реконструируются.

**Важная точность времени:** X `updated_at` — время текущего сохранённого снимка, а не `first_seen_at`; TG `collected_at` — время последнего сохранявшегося состояния, а не исходная первая дата получения; Blockchain `observed_at` сохраняется без подстановок. `posted_at`/`block_time` становятся отдельным occurredAt только когда исходное значение валидно. Нельзя приписывать нынешний текст твита его первой исторической версии.

## Безопасный запуск на ноутбуке (PowerShell)

В `intelligence/` после установки локальных Node 22 dependencies. Открывать только нужную source DB: `X_SOURCE_DATABASE_URL` / `TG_SOURCE_DATABASE_URL` / `SOLANA_TRADE_DB_PATH`. X/TG требуют существующего PostgreSQL Outbox, Blockchain — существующей SQLite outbox схемы. Данные соединения держать в локальном конфиге, а не в коммитах.

**Просмотр без записи, без RPC, без создания чекпоинта:**

```powershell
npm run etl:backfill -- --source x --limit 20
npm run etl:backfill -- --source tg --limit 20
npm run etl:backfill -- --source blockchain --limit 20
```

**Только после backup + восстановления тестовой копии:**

```powershell
$env:INTELLIGENCE_BACKFILL_ENABLED = 'true'
$env:INTELLIGENCE_BACKFILL_WRITE_ENABLED = 'true'
npm run etl:backfill -- --source x --execute --limit 20 --scope test-x-db --checkpoint C:\temp\intelligence-backfill-x.json
```

Каждый вызов сохраняет не более 100 событий-кандидатов из **одной страницы**. Повторять команду с тем же `--scope` и `--checkpoint`, пока не вернётся `complete:true`. Для Telegram/Blockchain использовать **разные** checkpoint-файлы и осмысленные уникальные scope. Не делить один checkpoint между разными базами и восстановленными копиями.

**Важный порядок включения:** источник Outbox и резервная копия → безопасный исторический backfill **только в source Outbox** → проверка числа pending и DLQ → отдельный ограниченный `intelligence/scripts/run.mjs --once` для доставки в отдельную Intelligence PostgreSQL (после миграций 001/002). Backfill НЕ создаёт директно строки в центральной БД, а значит сохраняет проверенную цепочку source Outbox → доставщик → inbox/timeline.

## Защита от остановки и дубликатов

- При первой команде `--execute` локально записывается **верхний ключ** текущего источника: последующие, более высокие ID не попадают в этот проход. Это граница по ключу, а не доказательство полной неизменяемой snapshot isolation.
- Каждая PostgreSQL страница блокирует выбранные исходные строки `FOR UPDATE` и записывает Outbox в той же транзакции. SQLite делает это в `BEGIN IMMEDIATE` через native better-sqlite3 transaction.
- Checkpoint — локальный JSON с версией, source, операторским scope, верхней границей, курсором и счётчиками. Пароли, сырые тексты публикаций и provider ответы туда не записываются.
- Checkpoint создаётся и обновляется атомарной заменой временного файла. `.lock` не позволяет запустить два backfill процесса на одном checkpoint; после аварийного завершения оставшийся `.lock` удаляется **только после проверки**, что процесс действительно остановлен.
- Очерёдность: сначала COMMIT в исходной БД, **потом** обновление checkpoint. Если процесс завершился между этими шагами, повторная попытка найдёт тот же event key и проверит payload на идентичность. Различающийся payload с тем же ключом — ошибка, а не беззвучное переписывание.
- Нельзя принимать короткую страницу как конец: выполнение требует *пустую* следующую страницу. Поскольку строки могут появляться или изменяться, по завершении нужен отдельный coverage-аудит.
- Некорректные исторические wallet/signature/hash/даты прерывают страницу; NULL `payload_hash` не заполняется выдуманным значением. X с отсутствующим стабильным author ID и TG без стабильного peer ID пропускаются и учитываются в `excluded`.

## Что ещё не готово

- Истинный immutable snapshot каждого изменения X/TG и физически полный журнал удалений: имеющаяся current-row БД не восстанавливает то, чего никогда не сохраняла.
- Реконструкция всех chain transfers/mint/burn/Token-2022 расширений, reorg/finality watcher и authoritative PnL.
- Автоматизированные циклы/backpressure/операторские health метрики именно для backfill, отличие «все обработанные записи» от «все существовавшие когда-либо»; исходный ETL supervisor существует отдельно.
- Создание новых **проверенных** mint-links из старого текста потребует независимого on-chain RPC с реальными точными версиями. Нельзя backfill выдавать за confirmed-token resolver.
- Интеграция актуальной `queryActiveTokenLinks` в авторизованный POTAPoff API и UI.

## Контроль перед merge/активацией

1. Доступны disposable PostgreSQL 16, SQLite + Node 22; CI показывает latest-head `Intelligence foundation`, `Intelligence CI`, `Repository hygiene` зелёными.
2. Тесты доказывают snapshot clocks, отсутствие приватного текста/ложного token entity, idempotent replay и rollback, отсечение невалидных author/peer/hash.
3. Проверен online backup SQLite WAL, PostgreSQL restore и целевой DB migration ledger **отдельно** от source-native X/TG migrations.
4. Все команды `--execute` запускать вручную на **изолированных тестовых копиях**, затем оценить coverage и стоимости хранения Outbox.
5. Пользовательская база не затрагивается до явного подтверждения допуска к live rollout.
