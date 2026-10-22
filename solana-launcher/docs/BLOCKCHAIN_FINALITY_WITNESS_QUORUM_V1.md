# Finality Witness Quorum v1 — offline signed reports (not consensus finality)

Этот этап, поверх PR #158, обеспечивает **подписанный, привязанный к
конкретной RAW-ревизии, двухсвидетельский приём наблюдений** о статусе
Solana-транзакции. Никакого автоматического присвоения финальности,
PnL или изменённых сделок нет.

## Модель доверия

- Пины `Ed25519 publicKey / keyId / endpointId / genesisHash` передаются
  **только из отдельного файла**, подготовленного оператором по независимому
  защищённому каналу. Код не открывает URL RPC, не читает API-ключи,
  не создаёт ключи подписантов и не «добывает» пины из входящего отчёта.
- Требуются ровно **два разных публичных ключа**, два разных `keyId`,
  два разных `endpointId` и одинаковый закреплённый `genesisHash`.
  Разные label и ключи **не доказывают**, что лежащие за ними RPC
  действительно являются независимыми backend/operator trust domains.
- Оба наблюдателя подписывают Ed25519 текст JSON под доменом
  `SOLANA-FINALITY-WITNESS-v1\0`. Payload содержит свой индивидуальный
  challenge, явную RAW source identity, время и связанные RPC-запросы/ответы.
- Внеартефактный `recoveryEpoch` (64 hex) должен храниться вне
  backup/restore domain SQLite. Мismatch при повторном открытии
  приводит к отказу. **Сам epoch не обнаруживает откат SQLite с
  сохранением прежнего epoch.** Для строгой anti-rollback гарантии
  нужен независимо удерживаемый монотонный CAS anchor.
- Даже два валидных отчёта означают только
  `two_pinned_witnesses_reported_finalized`.
  Это не криптографическая аттестация RPC-сервера,
  не гарантия неизменяемости цепи и **не** доказательство консенсуса.

## Данные и защита от повторов

Исходная SQLite открывается `readonly/query_only`. По signature делается
глубокий аудит всех сохранённых target-копий, текущего RAW,
архивных ревизий, coverage и execution. Challenge выдаётся только если
всё это имеет статус `PENDING_INDEPENDENT_FINALITY` без локальных flags.
Уникальный `source` содержит `kind,address,signature,slot,rawRevision,
rawSha256,revisionSetHash`; последний хеш привязан ко **всем** сохранённым
RAW-копиям данной signature, а не только к одному wallet target.

Отдельная SQLite `FW1Q` хранит:
- `witness_config`: внешний recovery epoch;
- `witness_challenges`: только SHA-256 nonce, origin/RAW binding,
  время выдачи, истечения и однократного использования;
- `witness_receipts`: неизменяемые подписанные envelopes,
  ключ/endpoint, context slot, RAW revision/hash и время приёма.

Выдача nonce и запись accepted receipt проходят в транзакциях.
Импорт использует одноразовый compare-and-consume + receipt INSERT в
**одной** транзакции состояния; одновременно проверяется всё ещё
актуальная RAW revision. После повреждения RAW/смены версии прежний
quorum не имеет силы. Неуспешная проверка не «сжигает» корректный nonce.

Контроль времени: TTL 1–300 секунд, свидетельство должно быть
создано после выдачи challenge, completedAt не позже trusted clock,
продолжительность опроса не больше 30 секунд и общее окно не больше
5 минут. Истекший nonce использовать нельзя.

## Формат pin-файла (вне Git)

```json
{
  "recoveryEpoch": "64_hex_characters_from_independent_operator_config",
  "witnesses": [
    {"keyId":"observer_a","endpointId":"out_of_band_a",
     "genesisHash":"SOLANA_GENESIS_BASE58","publicKey":"ED25519_PUBLIC_KEY_PEM_A"},
    {"keyId":"observer_b","endpointId":"out_of_band_b",
     "genesisHash":"SOLANA_GENESIS_BASE58","publicKey":"ED25519_PUBLIC_KEY_PEM_B"}
  ]
}
```

Это **только схема**. Подставить реальные независимо сверенные значения;
представленные placeholders не являются рабочими ключами.

## Запуск (из solana-launcher)

```bash
npm run blockchain:finality-witness-test

# Выдать nonce конкретному доверенному наблюдателю:
npm run blockchain:finality-witness -- issue \
  --db /absolute/path/collector.db \
  --state /absolute/path/witness.db \
  --pins /secure/trusted-witnesses.json \
  --kind wallet --address WALLET_BASE58 \
  --signature SIGNATURE_BASE58 --key-id observer_a

# После передачи nonce внешнему оператору и получения подписанного отчёта:
npm run blockchain:finality-witness -- accept \
  --db /absolute/path/collector.db \
  --state /absolute/path/witness.db \
  --pins /secure/trusted-witnesses.json \
  --file /secure/witness-a-signed-envelope.json

# Повторить выдачу и импорт для observer_b; затем:
npm run blockchain:finality-witness -- quorum \
  --db /absolute/path/collector.db \
  --state /absolute/path/witness.db \
  --pins /secure/trusted-witnesses.json \
  --kind wallet --address WALLET_BASE58 \
  --signature SIGNATURE_BASE58
```

Envelope: объект с ровно полями `payload` (JSON-строка)
и `signature` (canonical base64 Ed25519, 64 байта подписи).
Payload v1 содержит: `version=1,keyId,endpointId,genesisHash,
challenge,source,startedAt,completedAt,exchanges`.
`exchanges` обязаны содержать строго по порядку:
`getGenesisHash([])` и `getSignatureStatuses([[signature],
{searchTransactionHistory:true}])`, с уникальными
JSON-RPC `id` и соответствующими ответами.
Signature status обязан быть `finalized`, с `err:null`,
`status:{Ok:null}`, `confirmations:null` и тем же `slot`
что подтверждённый RAW. RPC `context.slot >= RAW slot`.

Подписант/внешний сетевой агент **не включён** в PR:
формирование свидетелями реальных подписанных response envelopes —
отдельный, требующий ревью trust/acquisition pipeline.
В этом этапе нет живых запросов, ключей подписи для реальных
наблюдателей или платных Alchemy обращений.

## Границы и следующий этап

Гейт финансовой авторитетности остаётся закрытым:
`consensusFinalityVerified=false`, `pnlEligible=false`.
Прежние `chain_wallet_trades`, `token_trades`, FIFO, inventory,
watcher invalidation outbox и настройки коллектора не изменяются.
Никакой report не переводит signature в `stable`.

Для доказуемой независимой финальности нужны отдельно:
доверенное получение RPC (TLS/acquisition provenance), настоящая
независимость backend/operator, антиоткатный внешний anchor,
цепочка финализированных block/slot proof и проверка reorg;
только после покрытия Inventory и реальной cost basis можно включать PnL.
