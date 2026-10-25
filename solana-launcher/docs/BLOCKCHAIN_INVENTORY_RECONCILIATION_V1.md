# Inventory Reconciliation v1 — offline, diagnostic only

Задача: проверить, можно ли объяснить изменение SPL token-account balance
реальными распознанными инструкциями `transfer/transferChecked/mintTo/burn`,
а не только меткой BUY или SELL.

## Состав изменений

- `blockchain-inventory-reconciliation.cjs`: независимый по каждому token account
  расчёт `post_atomic - pre_atomic` и суммы собственных декодированных движений
  `Σ(in_atomic) - Σ(out_atomic)`. Используются **только точные integer/BigInt**.
- `blockchain-inventory-decoder.cjs`: конфликтный pre/post owner получает
  `owner_conflict`, а не произвольно выбранного владельца.
  Небезопасные JS Number и дробные значения не превращаются в фиктивные atomic.
  Конфликтные mint/decimals блокируют получение косвенного mint.
- `blockchain-inventory-replay.cjs`: read-only аудит сохранённой SQLite
  (`chain_seed_events`). Проверяются gzip, SHA-256, signature/slot/time,
  исходный Alchemy RAW. Нет новых RPC-запросов и нет записи в исходную БД.
- `blockchain-inventory-reconciliation-test.cjs`: синтетические
  adversarial-тесты и воспроизведение **10 сохранённых реальных Alchemy swaps**.

## Запуск

Из `solana-launcher`:

```bash
npm run blockchain:inventory-test
npm run blockchain:inventory-audit -- --db /absolute/path/to/trade.db --limit 200
```

Лимит: 1–1000 RAW наблюдений. Отчёт выводится в stdout JSON.
`sampleTruncated=true` означает неполную выборку.
`uniqueSampleSignatures` не означает полноту истории кошелька.

## Интерпретация

| Status | Значение |
| --- | --- |
| `OBSERVED_BALANCES_MATCH_MOVEMENTS` | Декодированные движения арифметически объясняют доступные полные pre/post token-account балансы |
| `PARTIAL` | Недостаточно сведений о владельце, raw quantity, mint, decimals, аккаунте или обеих сторонах баланса |
| `MISMATCH` | Математическое расхождение; например, неизвестные SPL/Token-2022 механизмы или дополнительные движения |
| `CONFLICT` | Противоречие владельца, mint или decimals одного аккаунта |
| `FAILED_EXECUTION` | Транзакция с ошибкой исполнения, нет подтверждённого inventory движения |
| `UNKNOWN_EXECUTION` | Нет достоверного признака успешного исполнения |
| `NO_TOKEN_EVIDENCE` | Нет наблюдаемых token-account балансов и движений, **не** нулевое inventory |

Один и тот же token account может появиться на нескольких targets
(`wallet`, `token`) без появления новой сделки. Текущий отчёт
считает **наблюдения**, а не подтверждённые уникальные операции.

Ни один статус не является доказательством владельца кошелька в течение
всей истории, полного покрытия chain, Token-2022 transfer-fee parsing,
полного декодирования Jupiter/Raydium/Orca, достаточного cost basis,
безусловной финальности или готовности к авторитетному FIFO/PnL.

## Исправление безопасности RAW-revisions

`persistInventoryMovements` теперь атомарно заменяет **весь набор legs**
для конкретной `(target_kind,target_address,signature)`, а не только
обновляет совпавшие индексы. Если очередной RAW больше не содержит
распознанного transfer, прошлые legs удаляются и не становятся
фиктивными движениями inventory.

Операция выполняется внутри существующего `processOne` SQLite transaction,
в том же commit вместе с RAW revision, lease fence и checkpoint.
Регрессионный тест проверяет переход `2 legs → 0 legs` и rollback после
искусственной ошибки; исходный RAW и inventory должны остаться в
предыдущем согласованном состоянии.

Замена не делает исторический Token-2022 / WSOL / ownership ledger полным:
это исправление только **согласованности проекции с текущей RAW-ревизией**.

## Quality gates перед PnL

Для следующего этапа потребуются slot-time ownership intervals,
обработка account initialization/closure, Token-2022 withheld fees,
WSOL wrap/unwrap, неизвестной себестоимости, обязательный historical backfill,
finality confirmation и отдельные versioned allocations со ссылками на RAW.

**Это намеренно диагностика, а не миграция canonical `token_trades`
или `chain_inventory_movements` в финансовый ledger.**
