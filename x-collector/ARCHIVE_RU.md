# Архив X и исследование Solana-мемкоинов

Это расширение существующего X Collector. Основной парсер уже находится в `lib/trade/twitter-scraper.ts`, очереди/worker — в `lib/trade/tasks.ts` и `scripts/worker.ts`. Дополнительный crawler есть в `solana-launcher/backend/app/services/twitter_scrape_bridge.py` и discovery-модулях рядом. Они не доказывают полноту всего X за два года.

Добавлены migration 014, CLI `npm run archive -- ...`, отдельная страница `/archive` существующего dashboard, импорт локальных датасетов и официальный full-archive backfill. Ни live X запросы, ни production миграции в процессе разработки не выполнялись.

## Что означает период

Пользовательский период **08.10.2024–08.10.2026** трактуется включительно в Europe/Moscow. В CLI plan defaults: start `2024-10-08T00:00:00+03:00`, end **exclusive** `2026-10-09T00:00:00+03:00`. Окна — по одному дню, можно 1–31 день. Будущее/ещё не закрывшееся окно остаётся pending: worker обрабатывает только end <= now минус 30 секунд.

Каждый запрос имеет независимый checkpoint, cursor, ошибки и число страниц. `done` означает исчерпание пагинации данного запроса и окна, **не полноту всего X**. `partial` сохраняет успешные записи и сигнализирует о недоступных связанных объектах. Повторный запуск plan не создаёт дубликаты. `resume` позволяет явно повторить paused/partial окно. У 429 сохраняются cursor и next_attempt_at, используется reset и минимум 15 минут ожидания. Смена аккаунтов ради обхода лимитов не выполняется.

Full archive требует `X_ARCHIVE_BEARER_TOKEN` с соответствующим доступом X. Доступа у пользователя пока нет. `query` обязателен: wildcard/магического «всего Twitter» не добавлено. На локальном компьютере доступно примерно 35 GB свободного места и 16 GB RAM, поэтому полноценный планетарный архив здесь не помещается. Реальный объём выбранного охвата и стоимость источника пока не измерены.

## Хранение

- PostgreSQL: публикации по стабильным string ID, аккаунты, метрики-наблюдения, источники, replies/quotes/reposts/mentions, адреса, токены, снимки и цены.
- Сжатые content-addressed `.json.gz`: исходные ответы/порции файлов, включая поля, не вынесенные в нормализованные таблицы. Права файла 0600, каталога 0700.
- Для исходных Parquet-файлах сохраняются лицензия, авторство и контрольные суммы. Опция --manifest проверяет checksum JSONL перед импортом и записывает происхождение/авторство в source metadata. В git включены manifest/результаты проверок, а большие данные исключены.
- Импорт потоковый: не более 100 записей или примерно 4 MB в транзакции; есть hash файла и checkpoint строки. Повторный импорт того же файла пропускается.
- `ARCHIVE_MIN_FREE_GB=5` останавливает запись raw при нехватке диска. Это проверка файловой системы raw-хранилища; она не резервирует место под рост PostgreSQL/WAL и не является полной квотой диска.
- Резервировать нужно **и** PostgreSQL, **и** raw-каталог. Перемещая raw, обновите `archive_raw_pages.path` или сохраняйте прежний mount path. Автоматического удаления исторических данных нет.

На таком компьютере выбирается одна архивная сессия и pool 3. Архив отдельно от automation/publication Reply Guy. PostgreSQL вместо дополнительной графовой базы сохраняет текущую архитектуру. Большие Parquet можно анализировать вне транзакционной БД; ClickHouse/Neo4j здесь не нужны для первого этапа.

## Публичные данные и временная достоверность

Сохраняются доступные текст/дата/ID/язык, public_metrics, профили из expansions, сущности, media metadata/ссылки и связи. Медиафайлы не скачиваются. Likes — счётчик, **не полный список всех лайкнувших**; views — доступный impression_count, не история просмотров по людям. Не полученные значения — NULL, не ноль. Private/удалённые/ограниченные данные нельзя объявлять собранными.

`received_at` — время получения; `metrics_observed_at` — время достоверного наблюдения счётчика. Для файла без capture time оно NULL; явный metrics_observed_at/captured_at/scraped_at/collected_at нормализуется конвертером, если источник действительно фиксирует время метрик. Повторное возвращение счётчика к прежнему значению (A→B→A) сохраняется отдельными наблюдениями. Сегодняшние likes/views не выдаются за известные в 2024 году. Raw содержит оригинальные значения, а public profile table — последнее полученное состояние, не исторический реестр username. Предыдущие ответы сохраняются в raw.

Существующий scraper сохраняет handle, а не стабильный user ID, и может возвращать 0 при отсутствии DOM-метрики. Bridge сохраняет handle и все исходные поля в raw, не выдумывает user ID и не объявляет такие нули проверенными историческими метриками.

Связь tweet→mint основана на буквальном base58-адресе с проверкой Solana PublicKey. Это кандидат адреса: валидный адрес ещё не доказывает, что он SPL-token. `archive_author_connections` учитывает только адреса из реестра импортированных токенов; общий mint — общая тема, а не доказательство одного владельца/сговора. Не делайте глобальный quadratic graph join на очень больших таблицах без ограниченного подмножества.

## Реально найденные и использованные датасеты

| Источник | Покрытие | Лицензия и использование |
| --- | --- | --- |
| [SOLMEMES](https://huggingface.co/datasets/rucyfer/solmemes) | 8 960 строк; метаданные и первые 15 минут торгов graduated tokens; не твиты | Apache-2.0; скачан, checksum проверен, весь файл проверен через production storeToken в отдельном PGlite |
| [Solana Memecoin Dataset](https://github.com/ian05012/solana-memecoin-dataset) | 44 460 token snapshots, 10–29 июня 2026; не твиты | MIT / автор описывает research use; скачан только tokens.parquet, Git blob checksum проверен, весь файл импортирован в проверочную БД |
| [DLT-Tweets](https://huggingface.co/datasets/ExponentialScience/DLT-Tweets) | До ограничений API 2023 | Не подходит для требуемого периода; не импортирован |
| [Zenodo crypto discussions](https://zenodo.org/records/3895021) | Tweet IDs марта–мая 2019 | Не подходит по датам; не импортирован |
| [Bitcoin Tweets 2025–2026](https://www.kaggle.com/code/sumitchavhan7/bitcoin-tweets-dataset-2025-2026/input) | Обнаружена карточка с CSV 2.1 GB | Лицензия/полнота/колонки не подтверждены; не скачивается автоматически |
| [Instrumetriq samples](https://github.com/SiCkGFX/instrumetriq-public) | Агрегированный sentiment/market context | Samples CC BY 4.0, полный архив имеет другую лицензию; это не сырые Solana твиты, не импортирован |

В SOLMEMES 8 698 строк имеют created_at в выбранном периоде, 147 — без created_at, часть старше периода. Метаданные старого токена полезны и для упоминаний нового периода, поэтому весь reference dataset сохранён. После дедупликации: **7 965 mint/source записей, 8 934 различных исходных записей, 128 770 minute price samples**, 119 mint/source записей без даты создания. Различные траектории одного mint разделены record_hash, а не перезаписываются. Точный абсолютный anchor minute samples не выдумывается: пока он не подтверждён методологией, samples остаются относительными.

Во втором источнике: **31 013 mint/source записей и 44 460 исходных snapshot records**. Дата создания токена не выводится искусственно из captured_at. `features` и `labels` хранятся раздельно: известные max_return/reaches_2x/exit/peak/close-return поля — labels; сырой исходник сохранён. Не подавайте raw/labels в признаки модели. Неизвестная схема стороннего файла требует отдельной проверки полей. Обе выборки имеют survivorship/detection bias и не репрезентативны для всех запусков.

Результаты в `config/archive-datasets.json`. Это проверки в disposable DB, **не заполнение базы на компьютере пользователя**. Полного открытого датасета всех X-постов за весь период с полными просмотрами/профилями не найдено.

## Запуск на компьютере

Используйте существующую .env и предназначенную для collector PostgreSQL, после backup/проверки окна обслуживания. Migration 014 additive, но обычное построение нового индекса twitter_tweets может задержать записи на большой таблице.

```bash
npm ci
npm run migrate -- --status
npm run migrate
npm run dashboard
# http://127.0.0.1:3001/archive

# Перенос уже собранного существующим scraper, без запросов к X:
npm run archive -- bridge --max-batches 10

# Python нужен для Parquet, core archive остаётся TypeScript:
python -m pip install -r scripts/archive/requirements.txt
python scripts/archive/fetch-solmemes.py
python scripts/archive/fetch-memecoin.py
npm run archive -- import --file data/datasets/solmemes/solmemes.jsonl --manifest data/datasets/solmemes/manifest.json --format tokens
npm run archive -- import --file data/datasets/solana-memecoin/tokens.jsonl --manifest data/datasets/solana-memecoin/manifest.json --format tokens

# Только при наличии доступа к full archive. Без ключа run завершается явной ошибкой.
npm run archive -- plan --query "solana OR pump.fun OR memecoin"
npm run archive -- run --max-pages 1
npm run archive -- status
# Расширение известных conversations; страницы также ограничены явным run budget:
npm run archive -- plan-threads --limit 10
# Для следующей порции передайте выведенный next_after:
# npm run archive -- plan-threads --limit 10 --after CONVERSATION_ID
npm run archive -- resume 123
```

Query — пример тематической выборки, не подмена требуемого широкого охвата. Более широкий охват нужно разбивать на разрешённые источником запросы и фиксировать coverage. Браузерный scraper не получает обещание «полного» обхода; для него по-прежнему действуют прежние ограниченные задачи search/timeline/profile и остановка при CAPTCHA/лимитах.

Для CSV/JSONL/Parquet твитов:

```bash
python scripts/archive/convert-tweets.py --input tweets.csv --out tweets.jsonl --start 2024-10-08T00:00:00+03:00 --end 2026-10-09T00:00:00+03:00
# --mapping mapping.json: {"id":"TweetId", "text":"Body", "created_at":"Timestamp"}
npm run archive -- import --file tweets.jsonl --name MyDataset --url https://example.org/dataset --license LICENSE-ID --format tweets
```

Конвертер сохраняет большие IDs строками, сохраняет исходные колонки и не создаёт фиктивные ID/даты. Наивные timestamps трактуются как UTC, поэтому при иной timezone сначала нормализуйте источник. Schema описана в lib/archive/model.ts. Вендорские поля/raw JSON требуют проверенной лицензии; загружается только указанный локальный файл.

## Первые исследовательские запросы

```bash
npm run archive -- mentions --mint SOLANA_MINT --before 2025-04-01T00:00:00Z
```

Возвращает до 100 публикаций, опубликованных до cutoff, и только метрики, **наблюдённые** до cutoff. Более поздние/неизвестные метрики будут NULL. Это ещё не готовая торговая модель: для изучения связей нужны источники твитов, подтверждённые временные price anchors/OHLCV, комиссии/slippage и разделение train/test по времени. Общая topic связь не означает прогнозируемый доход.

## Проверки

Typecheck/lint/build; 55 тестов, включая Chromium archive UI/error recovery, миграции 001–014, пагинацию/dedup/checkpoint, partial coverage, неизвестные метрики, string IDs, token graph, разделение labels и CSV conversion. Native PostgreSQL CI дополнительно проверяет multi-snapshot prices и bridge checkpoint. Реальные файлы датасетов отдельно импортированы через storeToken в disposable PGlite. Живой full-archive X доступ и Docker build в этой среде не проверены.
