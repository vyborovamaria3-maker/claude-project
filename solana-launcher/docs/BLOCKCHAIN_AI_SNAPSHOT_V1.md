# Blockchain AI Snapshot V1

## Цель

`blockchain-ai-v1.1` — единый versioned контракт между детерминированной on-chain аналитикой и AI-отчётом.
Он собирает уже рассчитанные V1 / V3.4 / V3.5 метрики, DEV History V3, evidence coverage,
contradictions и temporal replay в один snapshot. AI не делает повторный RPC и не получает сырые
тысячи транзакций вместо готовых признаков.

Главное правило: `unknown/null != 0 != safe`.

## HTTP API

### `GET /api/trade/blockchain-ai`

Параметры:

- `mint` — Solana mint, обязательно.
- `detail=compact|full` — по умолчанию `compact`.
- `refresh=1` — обойти completed-result cache, но concurrent request для того же mint всё равно
  переиспользует уже идущий in-flight анализ.

`compact` предназначен для AI и UI. `full` дополнительно содержит lossless analyzed layers:
`full`, `qualityV1`, `qualityV34`, `qualityV35`, DEV History и verdict/drift structures.

### `POST /api/trade/blockchain-ai`

```json
{
  "mint": "<solana mint>",
  "refresh": false,
  "detail": "compact"
}
```

### `POST /api/trade/blockchain-ai-report`

```json
{
  "mint": "<solana mint>",
  "refresh": false
}
```

Endpoint сервер-сайд получает compact snapshot и отправляет его в существующий
`MEMECOIN_INTELLIGENCE` backend. Внутренних HTTP-вызовов к `chain-full` или `dev-history` нет:
shared server builders вызываются напрямую.

## Snapshot structure

Основные поля:

- `schemaVersion` — `blockchain-ai-v1.1`;
- `mint`, `generatedAt`, `asOf`;
- `cache` — источник/возраст reused deterministic analysis;
- `reportContract` — правила интерпретации и обязательные секции AI-отчёта;
- `headline` — lifecycle, composite scores + confidence, evidence completeness, safety counters;
- `dataQuality` — source/available/complete/coverage для evidence;
- `sections` — тематические normalized аналитические блоки;
- `facts` — плоские high-value facts для быстрого reasoning;
- `unknowns` — явный список недоступных/частичных доказательств;
- `warnings` — contradictions/anomalies;
- `analysis` — только в full snapshot, lossless analyzed outputs.

### `sections`

- `safety`
- `liquidity`
- `holders`
- `flow`
- `wallets`
- `bundles`
- `funding`
- `wash`
- `creator`
- `devHistory`
- `temporal`
- `contradictions`
- `anomalies`
- `events`

## DEV History

Compact snapshot включает historical creator track record, а не текущий DEV balance:

- previous launches;
- confirmed migration rate;
- ATH distribution/coverage;
- `$100k / $300k / $1M` hit rates;
- rolling trend;
- cadence;
- recurring wallet network;
- observed launch outcomes `+5m/+15m/+1h/+6h/+24h`;
- post-migration replay;
- per-horizon N/coverage.

Historical missing data не считается неудачей и не превращается в `0`.

## AI interpretation contract

AI обязан:

1. Отделять наблюдаемые факты от интерпретации.
2. Не трактовать `null` как ноль, отсутствие риска или доказательство безопасности.
3. Снижать уверенность при partial/low coverage.
4. Не трактовать funding как ownership.
5. Не трактовать coordination как insider control.
6. Не считать Jito tip доказательством atomic bundle.
7. Не трактовать confidence как вероятность будущей доходности.
8. Интерпретировать historical DEV outcomes только вместе с N/coverage.
9. Не превращать replay/backtest correlation в обещание будущего результата.
10. Явно перечислять contradictions и unknowns.

Обязательные секции отчёта задаются самим snapshot в `reportContract.requiredSections`.

## Performance design

- `chain-full`, snapshot API и AI report используют один shared chain-analysis cache.
- Concurrent requests одного mint разделяют один `inFlight` provider/RPC analysis, включая refresh.
- DEV History строится прямым server function, без loopback HTTP.
- Chain и DEV History запускаются параллельно через `Promise.all`.
- AI получает compact snapshot без дублирующего lossless `analysis` дерева.
- Compact snapshot имеет hard budget 220 KB и явные `payloadBytes / payloadTruncated / compactionLevel`.
- Полный compact snapshot передаётся upstream losslessly как ordered structured JSON chunks внутри совместимого `social-snapshot-v5` envelope.
- Hard upstream payload limit: 450 KB.
- AI upstream timeout: 45 s; client abort распространяется на upstream request.
- AI response нормализуется server-side; confidence приводится к share01, malformed rows отбрасываются.
- AI report cache fingerprint игнорирует только volatile DEV freshness timestamp, но инвалидируется при изменении аналитических значений/evidence.
- Heavy routes включены в существующий production rate-limit/auth boundary.

На synthetic large fixture после V1.0.1 hardening: compact JSON ~37.2 KB; snapshot build + compact serialize
~1.28 ms median and ~2.09 ms p95 в validation environment. Рост относительно V1 связан с глобальным byte-budget,
range normalization и lossless chunk transport; он остаётся пренебрежимо малым относительно provider/RPC и AI latency.

## UI

Blockchain tab заканчивается отдельным `BlockchainAiReportPanel`.
Он показывает dedicated blockchain report, snapshot schema/evidence/unknown/warning metadata и
поддерживает explicit refresh. Existing cross-source AI не удалён и не подменён.

## Compatibility

`chain-full` и `dev-history` сохраняются как отдельные API, но используют те же shared server services.
Это уменьшает дублирование и предотвращает расхождение данных между UI, raw API и AI report.

## V1.0.1 hardening

V1.0.1 закрывает source-time skew, stale DEV freshness, mixed coverage scales, cache invalidation races,
LLM runtime-shape failures, mint-switch UI races, unbounded AI payload, transport schema mismatch, silent
structured-snapshot truncation, prototype-pollution edge cases и response-section loss. `full` API остаётся
lossless analyzed view; compact AI transport может сокращать drill-down rows только при превышении hard byte
budget и всегда маркирует это через `compactMeta.payloadTruncated`.


## Claim Contract V1

V1.1 adds structured `claims[]`, exact `evidenceKeys`, optional machine-checkable `evidenceAssertions`, a server-side claim audit, and a combined `verification` verdict. See `docs/BLOCKCHAIN_AI_CLAIM_CONTRACT_V1.md`.
