# Alchemy Collector: безопасный первый этап Fee Intelligence (v1)

## Что реализовано

Два отдельных офлайн-инструмента. Они не вызывают Alchemy, не запускают collector,
не меняют исходную SQLite и **не записывают сделки, inventory или PnL**.

1. `scripts/blockchain-collector-baseline.cjs` — read-only диагностика
   доступных таблиц, RAW-наблюдений, ревизий, состояния пагинации,
   ошибок метаданных, сетевых комиссий в ограниченной выборке, попыток RPC и
   наблюдаемой задержки между block_time и observed_at.
2. `scripts/blockchain-fee-intelligence.cjs` — чтение текущих `chain_seed_events`
   и запись fee-evidence **в новый отдельный SQLite файл**. Никаких миграций
   боевой БД и никакого автоматического обновления финансовой аналитики.

Уже существующие `token_trades`, `chain_wallet_trades`, PnL quality gates,
`chain_seed_raw_revisions` и API-бюджеты не меняются.

## Команды

Из каталога `solana-launcher` (с установленными зависимостями):

```bash
npm run blockchain:baseline -- --db /absolute/path/to/trade.db --sample 200
npm run blockchain:fee-audit -- --db /absolute/path/to/trade.db --out /absolute/path/to/fee-review.db --limit 200
npm run blockchain:fee-test
```

Входная БД открывается с `readonly:true` и `query_only=ON`; требуется явно
указать путь. Режим комиссий требует новый `--out`, существующий файл не
перезаписывается. Проверки RAW ограничены по размеру, а количество строк —
флагом `--sample` (до 1000) либо `--limit` (до 5000). Это **выборка**,
а не утверждение о покрытии всей сети Solana.

### Необязательный реестр известных получателей

По умолчанию извлекается **только** `meta.fee` как
`network_total / EXACT_ONCHAIN`. Чтобы дополнительно найти возможные
комиссионные переводы, передайте JSON файл:

```json
{
  "jito_tip_accounts": ["VERIFIED_TIP_ACCOUNT_PUBKEY"],
  "services": [
    {
      "id": "verified-service-name",
      "recipient": "VERIFIED_FEE_RECIPIENT_PUBKEY",
      "from_slot": 1
    }
  ]
}
```

```bash
npm run blockchain:fee-audit -- --db /absolute/path/to/trade.db --out /absolute/path/to/fee-review.db --registry /absolute/path/to/recipient-registry.json --limit 500
```

**Это шаблон, не готовый реестр адресов!** Заменить placeholders только после
отдельной проверки владельца адресов, назначения платежей и действия тарифов
в конкретный исторический период.

- `network_total` — точный `meta.fee` в lamports. Он уже включает
  **base fee и priority fee**. Компоненты дополнительно не суммируются.
- `jito_tip_candidate` — подтверждённый System Program transfer на указанный
  адрес; **не доказательство** включения через Jito bundle.
- `service_fee_candidate` — подтверждённый System Program transfer на
  указанный адрес; **не доказательство**, что перевод является комиссией сервиса.
- Failed transaction сохраняет `network_total`, но **не** порождает комиссии
  из неисполненных инструкций.
- Все суммы — точные десятичные строки минимальных единиц; отсутствует
  преобразование через JavaScript `Number` для токеновых объёмов.
- Пока нет проверенного декодирования встроенных DEX/protocol fees,
  Token-2022 transfer fees, ренты, правил тарифа и отдельно доказанного
  priority/base split. Эти значения остаются неизвестными.

Нельзя суммировать `network_total` по разным целям (wallet/mint):
одна signature может наблюдаться много раз. Для уникального сетевого расхода
нужен отдельный согласованный transaction-level rollup с дедупликацией.

### Схема отдельного результата

`fee_projection_info` хранит диагностический manifest. `fee_evidence`
сохраняет `target_kind,target_address,signature,raw_revision,raw_sha256,event_key`,
`slot,block_time,fee_kind,amount_atomic,asset,payer,recipient,service_id`,
`classification_status,economic_role,evidence_path,reason`.

Идентификатор fee-event внутри RAW — `event_key`, связанный с outer/inner
instruction index. В выходной таблице его уникальность ограничена
`(target_kind,target_address,signature,raw_revision,event_key)`.
Это **проекция доказательств**, а не бухгалтерская проводка.

## Расширение: deduplication и DEX adversarial replay

Теперь по завершении fee-evidence проекции выполняется
`scripts/blockchain-fee-rollup.cjs`. Он создаёт **только в новой выходной БД**:

- `fee_network_consensus`: уникальная `signature`, число RAW-наблюдений,
  число уникальных RAW-хешей и результат сверки `OBSERVED_CONSISTENT /
  PARTIAL / CONFLICT`.
- `fee_payer_observed_totals`: сумма `meta.fee` по **уникальным signatures**,
  только для согласованных наблюдений с известным плательщиком и слотом.
  Суммы считаются в `BigInt`, хранятся строкой lamports; SQLite `SUM`
  не используется.
- `fee_transfer_consensus`: сверка отдельных кандидатов tip/service по
  `(signature,event_key)`, без добавления к подтверждённым издержкам.

При конфликте суммы, плательщика или слота `network_fee_lamports=NULL`
и конфликтная signature **не входит** в `fee_payer_observed_totals`.
Если хотя бы одно RAW-наблюдение этой signature некорректно, запись помещается
в `fee_invalid_observations`, а её согласование получает `WITHHELD` —
даже при наличии другой корректной копии. Это важно для предотвращения
селективного подтверждения комиссий по неполным доказательствам.
Повторение signature под несколькими targets не увеличивает итог.
Различие RAW-хешей отмечается в отчёте и не выдаётся за финальность.
Даже `OBSERVED_CONSISTENT` означает лишь согласие сохранённых наблюдений,
а не криптографическую финальность, полноту истории или подтверждённый PnL.

Новая команда `npm run blockchain:dex-adversarial-test` прогоняет
сохранённые реальные Pump-транзакции и синтетические adversarial-мутации:
split fill, неоднозначный multi-hop quote, несколько событий, слишком
большое атомарное количество, отсутствие доказательств исполнения,
нарушение signer-атрибуции и пути checked transfer.
Опасный вход обязан давать **0 подтверждённых сделок**. Это регрессия
отказа, **не** доказательство полной поддержки Jupiter, Raydium или Orca.

Пока **не добавлены** полноценный transaction-level inventory,
Raydium/Orca/Jupiter decoder fixtures и историческая оценка торговых fees.
Эти направления должны опираться на настоящие RAW-образцы для каждого
семейства DEX и отдельную проверку reconciliation.

## Публичные RAW-образцы и проверка балансов Solana

Добавлена офлайн-проверка `fee_balance_evidence` из
`meta.preBalances` и `meta.postBalances`: все суммы вычисляются как
`BigInt`, а математический инвариант —
`sum(postBalances) - sum(preBalances) == -meta.fee`.
Статус `MATCH` означает только согласование арифметики доступного RPC-ответа,
а **не** независимую криптографическую финальность транзакции.
При отсутствующих/небезопасных числовых значениях ставится `UNAVAILABLE`.
При прямом расхождении ставится `MISMATCH` и signature блокируется
(`WITHHELD`) для итогов `fee_payer_observed_totals`.

В тесты добавлены все **10 сохранённых реальных Alchemy swap-транзакций**;
их сохранённые pre/post SOL balances математически согласованы с `meta.fee`.
Кандидаты на комиссии торговым сервисам в этих транзакциях не утверждаются
без дополнительно проверенного реестра получателей.

`fee_transfer_consensus` теперь содержит:
- `CANDIDATE_CONSISTENT` — одна и та же потенциальная fee-transfer-инструкция
  видна во всех *выбранных* RAW-наблюдениях signature, но назначение платежа
  остаётся недоказанным;
- `PARTIAL` — в отдельных RAW-наблюдениях signature соответствующей инструкции
  нет;
- `WITHHELD` — сетевые данные signature противоречивы, повреждены или
  не прошли проверку балансов;
- `CONFLICT` — расходится адрес получателя, плательщик, сумма либо классификация.

Никакой статус `fee_transfer_consensus` не зачисляет кандидата
в подтверждённый PnL. Данные ограничены выбранным RAW sample,
поэтому отсутствие другого наблюдения в выборке не доказывает полное
покрытие сети или идентичность всех версий источника.

## Следующие этапы (не выполнены данным PR)

1. Расширить сохранённые adversarial DEX fixtures для Raydium/Orca/Jupiter,
   PumpSwap, multi-hop и split routes; неизвестные исполнения сохранять как UNKNOWN.
2. Реализовать проверяемые multi-leg декодеры в отдельной версии; проверить
   суммы на atomic units и не переписывать канонический `token_trades`.
3. Завершить inventory/finality/reconciliation; снять гейт авторитетного PnL
   только после подтверждённой полноты, порядка и себестоимости.
4. Добавить строгий fee attribution: проверенные программы, версии тарифов,
   fee allocation по сделкам, embedded DEX fees, historical valuation.
   `service_fee_candidate` и `jito_tip_candidate` нельзя автоматически
   считать подтверждёнными издержками без дополнительных доказательств.
5. Только после измерения фактических p95/p99 задержек и сравнительного
   теста рассматривать WebSocket; очередь и backfill остаются постоянными.

### Проверки

`node scripts/blockchain-fee-intelligence-test.cjs` покрывает
небезопасные числа, базовую и сетевую комиссию без двойного учёта,
кандидатные получатели, неуспешную транзакцию, неизвестные получатели,
битый RAW hash и повторные наблюдения одной signature.

Локальный production DB не используется. Никаких платных RPC запросов
и скрытого перезапуска коллектора нет.
