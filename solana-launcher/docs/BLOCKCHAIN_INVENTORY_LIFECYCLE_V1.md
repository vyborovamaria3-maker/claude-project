# Inventory lifecycle / ownership observations — v1

Эта реализация **не** является полноценным историческим Inventory Ledger,
не вычисляет FIFO и не создаёт PnL. Она дополняет PR #155 проверяемыми
наблюдениями владельцев и жизненного цикла SPL token accounts.

## Источники и доказательства

- `chain_seed_events` из текущей SQLite коллектора: gzip + сохранённый SHA-256,
  signature, slot и block time. RAW читается с `readonly:true`.
- `preTokenBalances/postTokenBalances`: mint, owner, accountIndex,
  atomic token balance (без вещественных чисел).
- `decodedOperations`: только распознанные инструкции Token и Token-2022.
- Разные RAW-копии **одной** signature со своими значениями SHA-256,
  а также любая повреждённая копия в выбранной выборке, исключают всю
  signature из этой версии проекции. Совпадающие копии дедуплицируются.

## Новые компоненты

`scripts/blockchain-inventory-lifecycle.cjs`

Фиксирует по каждому аккаунту наблюдение владельца на конкретном слоте.
Сопоставляет pre/post. При несовпадении owner, mint или decimals выдаёт
проверяемую причину, а не выбирает владельца автоматически.

Из parsed instructions отмечает:
- `ACCOUNT_INITIALIZE` — наличие инструкции создания токенового аккаунта;
  дополнительно сверяет mint/owner с post snapshot.
- `ACCOUNT_CLOSE` — наличие инструкции закрытия; `EFFECT_CORROBORATED`
  только при нулевом pre-token balance, отсутствии post-token balance и
  нулевом post-lamport balance. Возврат rent **не записывается как комиссия**.
- `WSOL_SYNC_NATIVE` — `syncNative` у подтверждённого WSOL mint —
  **не сделка**. Без подтверждения WSOL mint не присваивается.
- `OWNER_AUTHORITY_CHANGE` — наблюдаемая попытка изменения owner authority.
  Нужна независимая проверка реального владельца после инструкции.
- `TOKEN2022_FEE_MECHANISM` — parsed Token-2022 operations о withheld /
  transfer fees. **Сумма и экономический плательщик остаются неподтверждёнными**.
  В текущем PnL это не отдельная комиссия.

`scripts/blockchain-inventory-history.cjs`

Создаёт **только новую отдельную SQLite** с таблицами:

| Таблица | Назначение |
| --- | --- |
| `inventory_owner_observations` | owner + mint + token account на конкретном слоте, сторона pre/post, SHA-256 источника |
| `inventory_owner_observed_spans` | минимальный и максимальный **наблюдённые** слоты владельца |
| `inventory_lifecycle_events` | инструкции initialize/close/syncNative/setAuthority/Token-2022 с осторожным статусом |
| `inventory_history_issues` | Несовпадения owner/mint, недостающие доказательства и переходы |
| `inventory_rejected_signatures` | Повреждённые или расходящиеся RAW-наблюдения |
| `inventory_projection_info` | Manifest, размер и ограничения выборки |

**Важное ограничение:** `inventory_owner_observed_spans` —
*только крайние точки наблюдений*, не непрерывный действительный интервал
владения. `continuity_proven = 0` всегда. Даже одна и та же связка
account/owner на слотах 100 и 200 **не** доказывает владение на слотах 101–199.

Историческая передача владельца между отдельными наблюдениями
помечается `OWNER_OR_MINT_CHANGED_BETWEEN_OBSERVED_ENDPOINTS_UNPROVEN`.
Статус `POST_BALANCE_CORROBORATED` или `EFFECT_CORROBORATED` не
подразумевает finalized proof.

## Запуск

Из `solana-launcher`:

```bash
npm run blockchain:lifecycle-test
npm run blockchain:lifecycle-audit -- --db /absolute/path/trade.db --out /absolute/path/lifecycle-evidence.db --limit 200
```

`--db` должен существовать; `--out` **обязан отсутствовать**.
Никаких вызовов Alchemy/RPC, обновления `chain_inventory_movements`,
`token_trades` или PnL не производится. При ошибке выходная БД удаляется.
Граница выборки — не более 1000 RAW-наблюдений, а не 1000 уникальных
финализированных транзакций.

## Следующий блок работ перед полноценным Inventory Ledger

1. Дополнить реальные RAW-фикстуры Token-2022 transfer fees, withheld balance,
   account close/init и WSOL. Текущие 10 сохранённых Alchemy swaps
   — только общая регрессия, не доказательство всех этих сценариев.
2. Проверять cryptographic / verified RPC finality, полный backfill по адресу,
   monotonic coverage, reorder/reorg и отсутствие пропущенных signature.
3. На базе финализированных движений строить версионированные лоты и
   cost-basis provenance. `UNKNOWN_BASIS` не превращать в ноль.
4. После проверенной полноты и сверки добавить экономически корректные
   allocations network/Jito/service/embedded fees без двойного списания.

`financialLedgerEligible=false` на всём этом этапе. PR не меняет
канонический `token_trades` и не делает PnL авторитетным.
