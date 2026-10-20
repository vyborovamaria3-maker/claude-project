# ARCH-06a — подтверждаемая связь wallet swap → Solana mint

## Статус и ограничение

Draft, ветка поверх ARCH-11 + фиксов PR #145. **Это только первая, консервативная часть ARCH-06.** Настоящий SOL/WSOL-quoted parsed swap наблюдается через уже существующий parser `blockchain-forensics-core.cjs`. Он может сообщить о mint-адресе токена, но не гарантирует полный trade tape, блоковую финальность, SPL Mint account owner, отсутствие reorg, безошибочный PnL или исчерпывающий wallet history.

## Как работает

- `solana-launcher/scripts/blockchain-token-swap-outbox.cjs` — отдельный источник immutable `token_swap_evidence_observed`, построенный из **текущих Helius-compatible raw wallet events**. Он не делает RPC, новых сетевых запросов, чтения токенов или новых таблиц.
- Для публикации одновременно требуются два opt-in флага: `BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED=true` и `BLOCKCHAIN_INTELLIGENCE_TOKEN_EVENTS_ENABLED=true`. Новая функция **выключена по умолчанию**.
- Сырой объект должен быть успешным `SWAP`, содержать правильный Solana wallet (32 decoded bytes), Solana signature (64 decoded bytes), SHA256 исходного raw payload, валидные `timestamp`, `slot`, `accountData`, `events.swap`.
- Существующий форензик-парсер обязан выдать **одну-единственную** однозначную buy/sell операцию с SOL/WSOL quote и сопоставлением балансов кошелька. Если есть смешанные токены, непроверенный fee/native balance, отсутствующее число или unknown/unpriced leg, событие mint-связи не публикуется.
- В `registryEvent.entityRefs` записываются `wallet: solana:<wallet>` и `token: solana:<mint>`. `evidenceRef` содержит точную подпись `chain:tx:solana:<signature>`, occurredAt/observedAt. Стабильный `eventKey` включает wallet, подпись, source SHA256 и parser version.
- В Timeline событие называется **`chain_transaction`**, а не `trade_executed`. Payload содержит `historical_raw_revision_only`; **нет** amounts, prices, секретов, wallet PnL, провайдерского raw payload или раскрываемого API key.
- Оно публикуется **в той же better-sqlite3 транзакции** с сырой записью, базовым blockchain outbox событием и source checkpoint. При ROLLBACK никаких новых доказательств не остаётся. Повтор неизменного источника идемпотентен.

## Три причины, почему это НЕ финальный ARCH-06

1. **Повторные редакции RAW.** Если новый raw той же signature опроверг старую декодировку, новая версия может не содержать токен. Старая запись сохраняется как историческое свидетельство о прошлой декодировке, не как активная/окончательная связь. Нужно построить явную систему revision-aware supersession/tombstones и в UI учитывать только актуальную версию для операционного token-trade утверждения.
2. **Mint account verification.** Тип `mint` взят из Helius-compatible parsed swap leg; это не independent `getAccountInfo` SPL Mint type check, как в X/TG. Поэтому пользовательскому UI запрещено показывать `mint_verified_on_chain` для этого источника. Пока надпись должна означать только `provider_parsed_wallet_swap`.
3. **Покрытие.** Wallet collector не охватывает все кошельки, маршруты, Token-2022 extensions, события burn/mint, все DEX-пулы, inner swaps, неизвестные котировки и reorg. Отсутствие Blockchain записи в Timeline — не отсутствие сделки. Нет обещаний полноты trade tape или надежного realized PnL.

## Локальное включение (только после backup / review)

Установить на ноутбуке два явных флага источника и отдельно запустить обычный `blockchain-seed-collector.cjs`. Сборщик уже должен иметь свою SQLite базу, target и разрешённые provider credentials. ARCH-06a не развёртывает сервер, не перезапускает Docker и не импортирует Excel без явной команды.

```powershell
# Оба флага выключены по умолчанию. Пример только имен переменных:
$env:BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED = 'true'
$env:BLOCKCHAIN_INTELLIGENCE_TOKEN_EVENTS_ENABLED = 'true'
```

Разворачивать только после сохранённой и **проверенной на восстановление SQLite backup с WAL** и проверки целевой Intelligence PostgreSQL миграций 001/002/004. Без опроса новых RPC можно проверить уже сформированные доказательства в SQLite по `event_kind='token_swap_evidence_observed'`, затем безопасно запустить ограниченную доставку (другие flags отдельно).

## Тесты

- `node scripts/blockchain-token-swap-outbox-test.cjs` из `solana-launcher` — синтетический Helius-compatible RPC fixture, проверки ошибочного времени, неканонических wallet/mint/signature, transfer/unknown/error, многотокенного swap, несовпадений кошелька и баланса.
- PostgreSQL/SQLite транзакции не объединены: атомарность по raw source/outbox обеспечивается SQLite, destination идемпотентностью, source ACK только после COMMIT. Реальная трёхисточниковая delivery проверяется отдельно в `intelligence`.
- `npm run blockchain:test` запускает регрессионный тест вместе с существующим blockchain набором в CI. Никакие платные RPC не вызываются.

## Следующие отдельные этапы

- ARCH-06b — source-version supersession, привязка конкретного finalized transaction/slot и осторожное разрешение настоящего SPL Mint.
- ARCH-06c — надёжные multiple-leg DEX semantics, quote amounts (raw integer precision), canonical transaction-level dedup по нескольким wallets, Token-2022, burn/mint/transfer/ATA и reorg/unknown coverage.
- Только после этого — user-facing trade execution / PnL API и UI с явной оценкой полноты.
