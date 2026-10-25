# Durable finality observation watcher v1 — fail-closed

Продолжение PR #157. Здесь **реализован перезапускаемый watcher над уже сохранённым
RAW**, а не независимый finalized/reorg verifier. Публичный RPC, Alchemy и
данные продакшн-кошельков не запрашиваются без отдельного явно разрешённого
live-этапа. Слово «watcher» означает повторный аудит с постоянным состоянием.

## Реализовано

- `blockchain-finality-watch-state.cjs` открывает исходную SQLite исключительно
  в `readonly` + `query_only` и требует отдельный state-file.
- Новая SQLite с `application_id=FIW1`, version=1:
  - `watcher_scopes`: сохранённый cursor, monotonic check sequence;
  - `watcher_current`: последняя привязанная RAW/quality fingerprint
    для signature и scope;
  - `watcher_observations`: append-only журнал каждого **изменения**;
  - `watcher_invalidation_outbox`: append-only **план ручной проверки**.
- Все текущие подписи берутся из индекса `chain_seed_events`, а уже
  наблюдавшиеся signatures периодически пересматриваются отдельно,
  включая исчезнувшие из источника после удаления RAW.
- Каждая перепроверка вызывает существующий
  `blockchain-history-finality-audit.cjs`: сверяется signature, slot,
  все доступные target-копии, RAW checksum, архивные ревизии и coverage.
- Fingerprint учитывает `kind,address,revision,raw_sha256,slot,status,flags`.
  Другая RAW-ревизия, конфликт или downgrade создают outbox запись.
  Без изменения fingerprint новых записей не добавляется.
- Сохранение журнала, обновление курсора и постановка в outbox происходит
  в одной транзакции отдельной state-базы. Статус
  `pending_independent_finality` **не** превращается в `stable`.
- Команда работает однократно по умолчанию или в явном `--watch` режиме,
  с последовательными проходами и интервалом 60–3600 секунд.

## Запуск (из каталога solana-launcher)

```bash
npm run blockchain:finality-watch-test

# Посмотреть необработанную очередь инвалидаций, ничего не применяя:
npm run blockchain:finality-watch-report -- --state /absolute/path/to/finality-watch-state.db --limit 50

# Однократный bounded read-only проход (до 25 signatures):
npm run blockchain:finality-watch -- \
  --db /absolute/path/to/trade.db \
  --state /absolute/path/to/finality-watch-state.db \
  --kind wallet --address WALLET_BASE58 --limit 25

# Явно запущенный оператором повторный процесс:
npm run blockchain:finality-watch -- \
  --db /absolute/path/to/trade.db \
  --state /absolute/path/to/finality-watch-state.db \
  --kind wallet --address WALLET_BASE58 --limit 25 \
  --watch --interval-seconds 300
```

Все вызовы выполняются локально. Нет чтения Alchemy API-ключей, RPC,
планировщика продакшн-задач и фонового сервиса по умолчанию.

`--db` и `--state` не могут указывать на один файл (включая
hardlink). `--state` создаётся с правами 0600 и не заменяет существующую
произвольную SQLite. Первая инициализация нового state-file происходит
явно; повторные запуски используют ту же проверяемую версию схемы.

## Дополнительная проверка надёжности (PR review)

- При открытии state SQLite проверяются не только app-id и version,
  но и обязательные таблицы/колонки, защитные триггеры и внешняя связь
  outbox → observation. Повреждённая структура вызывает отказ от запуска.
- Создание схемы теперь атомарно; SQLite state использует
  `journal_mode=WAL` и `synchronous=FULL`.
- Для каждого scope время проверки не может уменьшаться. Откат часов
  блокирует обновление курсора и журнала до устранения причины.
- Read-only снимок исходной SQLite завершается **перед** фиксацией
  транзакции state/outbox. Синтетическая ошибка завершения снимка
  проверена тестом отката журнала.
- Fingerprint включает не только RAW, slot и статусы, но и
  нормализованные checkpoint/coverage metadata (провайдер,
  счётчики наблюдений и флаги gap/backfill). Смена этих сведений,
  даже при прежнем статусе, создаёт запись ручной проверки.
- Возврат доказательств к прежнему значению `A → B → A`
  остаётся новым событием в append-only журнале; пересечение с
  ранее сохранённым хешем не подавляет историю.

**Ограничение восстановления:** отдельная state SQLite сама по себе не
защищена от *одновременного* отката или восстановления её backup.
Криптографическая невозможность такого отката требует внешнего
монотонного anchor/свидетеля, находящегося в другом домене резервирования.
Текущий PR не утверждает anti-rollback guarantee и не использует журнал
как доказательство консенсусной финальности. После изменения алгоритма
fingerprint на ранее созданной тестовой state базе возможны новые
ручные события пересверки; они не меняют PnL.

## Результат

`pending_independent_finality` — сохранённые наблюдения согласованы
и ждут независимого заверенного RPC-факта о финальности.

`disputed_evidence` — расхождение RAW/slot/revision или повреждение
источника; **не** утверждение о сетевом reorg.

`execution_not_proven` — результат выполнения failed/unknown.

`history_incomplete` — нет исходных наблюдений, покрытие неполное или
архив недостаточен.

Любое ухудшение или изменение RAW fingerprint создаёт
`watcher_invalidation_outbox.state='pending'`, которую **не запускают
автоматически** против `token_trades`, `chain_wallet_trades`,
`chain_forensic_wallet_sync` или Inventory. Старые состояния и журнал
сохраняются для review. При первичном обнаружении уже проблемной
signature также создаётся pending инвалидация.

## Чего НЕ делает

- Не вызывает `getSignatureStatuses`/RPC и не удостоверяет происхождение
  результата. Существующий `blockchain-rpc-provenance.cjs` подтверждает
  signed collector observation для узкого swap proof и требует атомарного
  challenge consumption; он не является универсальным finality proof.
- Не присваивает `finalized_at`, `reorg_status='stable'` или
  `history_status='complete'`. Не меняет параметры коллектора.
- Не даёт криптографических доказательств consensus finality, непрерывной
  истории владения, полного Token-2022 inventory, cost basis и FIFO.
- Не применяет автоматически инвалидации к рабочей БД: требуется
  отдельный review/migration с тестами отката и влияния на PnL.
- Не включает внешний worker в production; расписание watcher
  запускается только прямой командой пользователя.

Гейты `independentFinalityVerified=false`,
`historyComplete=false`, `pnlEligible=false` остаются жёсткими.
Следующая отдельная PR-фаза — trust-pinned, independently challenge-bound
finalized RPC acquisition и сопоставление двух проверяемых наблюдений
без истечения срока и replay, с fail-closed downgrade и компенсацией
при RAW/reorg конфликтах.
