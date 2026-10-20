# ARCH-06b1 — состояние доказательства по версии raw wallet transaction

Статус: **Draft**, зависимость от ARCH-06a PR #147. Это не полный ARCH-06b и не торговый PnL.

## Модель

- Исторические `token_swap_evidence_observed` из ARCH-06a остаются **неизменяемыми**. Старые raw SHA и mint остаются фактами о прошлой декодировке, но не являются актуальными утверждениями.
- При каждом **изменении** `chain_seed_events.payload_hash` (и только при двух opt-in флагах) сборщик атомарно добавляет `token_swap_evidence_revision` в SQLite Outbox. Номер берётся из `chain_seed_events.raw_revision`, поэтому нет гонки с собственным инкрементом. Непарсящийся/неоднозначный/ошибочный raw даёт `unsupported` с `canonicalTokenId: null`, **даже если прошлый raw был swap**.
- `unsupported` означает «эта версия данных не поддерживает прежнюю связь». Это НЕ утверждение, что транзакции не было или блок откатился. Только однозначно разобранный swap имеет состояние `supported`, mint и slot; токен в реестре для неподтверждённой версии не создаётся.
- Новая схема Intelligence `005_blockchain_swap_evidence_revisions.sql` хранит версии append-only с уникальностью `(wallet_id, signature, raw_revision)`; обработка идёт в одной PG-транзакции с inbox, ACK источника — после COMMIT.
- `queryActiveBlockchainSwapEvidence(tokenId, occurredBefore, knownAt)` выбирает **максимальный raw_revision**, существовавший к `knownAt`, для каждого `(wallet,signature)`, и возвращает только `supported` c `occurred_at <= occurredBefore`. Порядок доставки не влияет на актуальную версию. На уровне **одного токена** `(signature,mint)` показывается один раз при нескольких наблюдавших кошельках. Межтокеновая trade-дедупликация/агрегирование не реализованы.
- Старые события ARCH-06a намеренно **не поднимаются** автоматически в current-view, потому что они не дают полного источника sequence/retraction. Старый `queryTokenTimeline` по-прежнему отдаёт исторические события и НЕ является API актуальной торговли.

## Важные ограничения

1. Исторические исправления до включения ARCH-06b или обновления исходного RAW не реконструируются. Для старых текущих записей нужна отдельная проверяемая offline backfill-процедура с SQLite backup; не делайте её автоматически.
2. Две независимые opt-in переменные по-прежнему обязательны: `BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED=true` и `BLOCKCHAIN_INTELLIGENCE_TOKEN_EVENTS_ENABLED=true`. Defaults OFF; никаких новых RPC и серверов. Отключение флага означает отсутствие новых revision-сигналов; нельзя обещать актуальность stale данных за интервал OFF.
3. Только валидность parsed swap и согласованность wallet balance из старого форензик-парсера: **нет independent SPL Mint account owner proof, block finality/reorg validation, полного покрытия DEX/Token-2022, точной цены, PnL или полной истории торговли**.
4. PG-миграцию `005` применяйте только после ревью и проверенной резервной копии на целевой изолированной базе; реальные PostgreSQL/SQLite и кредиты RPC этим PR не затрагиваются.
5. Token Timeline API продолжает отображать historical ревизии ARCH-06a. UI должен чётко разделить historical и current API перед показом «актуальных сделок».

## Проверки

- `cd solana-launcher && node scripts/blockchain-token-swap-outbox-test.cjs`: SQLite :memory:, source rollback/replay, последующие supported/unsupported версии и отключение opt-in.
- `cd intelligence && npm test`: новый `blockchain-swap-revisions-postgres.test.mjs` работает только при заданном `INTELLIGENCE_TEST_DB_URL` и создаёт отдельную случайную PostgreSQL schema, затем удаляет её. Проверяются ас-of, запоздалая доставка, повторение, замена mint, отрицательная версия, источник с другого wallet.
- Всё остаётся в ветке Draft до проверки полного CI и отдельного решения о merge.

## Следующие этапы

ARCH-06b2: независимая проверка owner/типов SPL Token и Token-2022 Mint (без неконтролируемого RPC), commitment/finality/reorg semantics, явная политика TTL и неполноты. ARCH-06c: точная multi-leg DEX/Token-2022 семантика, сквозной transaction+leg identity и полнота/неполнота торговой истории. Ни один шаг не должен автоматически объявлять эти события confirmed PnL.
