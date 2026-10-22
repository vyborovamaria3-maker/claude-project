# Историческое покрытие и финальность: Evidence audit v1

Этот этап НЕ утверждает, что история кошелька полна или что транзакции
криптографически финализированы. Он подготавливает проверяемый список проблем
для независимой RPC-проверки и будущего finalized/reorg watcher.

## Что делает

`scripts/blockchain-history-finality-audit.cjs` **только читает** существующую
SQLite коллектора. Нет Alchemy, запросов в сеть, миграций, конфигурации
API-ключей, обновления `chain_wallet_trades` или изменения PnL.

1. Выбирает не больше 200 **различных signatures** (или одну по
   `--signature`), затем проверяет *все* доступные RAW-копии каждой signature
   (не больше 20 целевых адресов для одной signature; больший объём получает
   флаг `TOO_MANY_TARGET_COPIES_TO_AUDIT`).
2. Сверяет gzip, размер, сохранённый SHA-256, signature, slot,
   время и распознаваемость Alchemy RAW через имеющийся декодер.
3. Проверяет `chain_seed_raw_revisions`: текущая версия должна присутствовать
   в архиве и совпадать с текущей RAW. Отсутствие старых ревизий отмечает,
   а не реконструирует. Ограничение — 32 ревизии на наблюдение.
4. Сравнивает RAW-хеши и слоты между wallet/token/dex targets.
   Расходящиеся текущие RAW или исправленные revisions не считаются
   доказанной reorg, но требуют повторной независимой проверки.
5. Сверяет текущие `chain_seed_targets` и
   `chain_forensic_history_coverage`, отдельно отмечает
   backfill, `possible_gap`, `forward_cursor`, конфликты provider metadata.
6. Формирует список `recheck.rawRevisions`, содержащий
   `kind/address/signature/rawRevision/rawSha256/slot`. Это **привязки
   будущих проверок**, а не само по себе доказательство финальности.

## Пример запуска

Из `solana-launcher`:

```bash
npm run blockchain:history-finality-test
npm run blockchain:history-finality-audit -- --db /absolute/path/to/trade.db --limit 50
npm run blockchain:history-finality-audit -- --db /absolute/path/to/trade.db --signature BASE58_SIGNATURE
npm run blockchain:history-finality-audit -- --db /absolute/path/to/trade.db --kind wallet --address WALLET_PUBKEY --limit 50
```

Режим `--kind wallet --address ...` выбирает signatures по составному
индексу target, а затем сверяет все другие известные target-наблюдения тех же
signatures. Это удобнее для большой SQLite, чем глобальный DISTINCT скан.
`--signature` нельзя объединять с `--kind/--address`.

Результат — JSON в stdout. Источник открывается с
`readonly:true, fileMustExist:true`, `query_only=ON`.

## Интерпретация

- `PENDING_INDEPENDENT_FINALITY`: RAW, доступные ревизии и локальные
  флаги покрытия непротиворечивы. **Не подтверждена финальность.**
- `RECHECK_RAW_BEFORE_FINALITY`: повреждение, несогласованная версия,
  неодинаковые RAW-копии или недостающая ревизия. Нельзя использовать
  в финансовых расчётах без устранения причины.
- `INCOMPLETE_HISTORY_OR_REVISIONS`: отсутствие checkpoint-а,
  незавершённый backfill, возможный gap, источник или ревизии неизвестны.
- `NO_SUCCESSFUL_EXECUTION_EVIDENCE`: в выбранных данных нет
  подтверждённого успешного исполнения (failed tx или статус неизвестен).

`finalityVerified=false`, `historyComplete=false`,
`pnlEligible=false` остаются **всегда**.
Даже `provider_exhausted` — только локальная запись о выполненной
пагинации конкретного адреса; она не подтверждает учёт всех операций
кошелька, всех token accounts, Token-2022 и DEX-декодирование.

Существующий `blockchain-rpc-provenance.cjs` содержит более сильную
схему с signed collector observation и одноразовым challenge, но даже
такое свидетельство **не** является криптографической финальностью.
Его не следует обходить доверяя произвольному JSON `getSignatureStatuses`.
Данный аудит не принимает сторонние файлы с «финальными» статусами.

## Следующие шаги

1. Внедрить **явно включаемый** ограниченный finalized watcher с
   independent/witness-bound RPC acquisition и устойчивым журналом
   revision-bound attestations. Сверять `getSignatureStatuses`, signature/slot,
   genesisHash и подтверждённую привязку RAW.
2. При откате/reorg, конфликте slot/hash или изменении RAW revision
   инвалидировать производные caches и cost basis без обновления
   канонического `token_trades` до отдельного review.
3. Добавить завершённый replay всей истории токеновых аккаунтов,
   ledger reconciliation, Token-2022 и WSOL для Inventory и FIFO.
4. Критерии PnL — не только локально подтверждённая подпись, но также
   доказанная полнота истории и себестоимость, порядок операций,
   подтверждённые fees и parity `token_trades`.

Регрессия использует сохранённые реальные Alchemy RAW и тестирует
дубли разных targets, ревизии, изменение содержимого, повреждение hash,
ошибочное или неизвестное исполнение, отсутствие слота и coverage metadata. Никаких платных
или live-запросов в рамках PR не выполняется.
