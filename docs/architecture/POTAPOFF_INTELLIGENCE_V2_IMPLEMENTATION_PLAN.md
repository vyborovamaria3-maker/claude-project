# POTAPoff Intelligence V2 — план реализации

Дата: 2026-11-12  
Рабочая ветка: `codex/architecture-hardening-20261105`  
Интеграционный PR: [#215](https://github.com/vyborovamaria3-maker/claude-project/pull/215)

> Это исполняемый план работ и критерии приёмки, а не заявление о готовности production. Текущий код, тесты и фактическое состояние GitHub важнее старых статусных документов.

## 1. Цель

Довести POTAPoff Intelligence до воспроизводимой evidence-first платформы для анализа X, Telegram и Solana: события поступают по версионированным контрактам, безопасно доставляются, связываются с сущностями только по проверяемым доказательствам, превращаются в версионированные признаки и корреляции, а AI объясняет результаты, не подменяя факты.

Порядок разработки: **контракты → доставка → coverage → identity → features → correlation/graph → deterministic intelligence/backtesting → AI orchestration → UI/controlled rollout**.

## 2. Зафиксированные архитектурные решения

1. **Сейчас поддерживается Solana-only blockchain scope.** В текущем `ARCHITECTURE_TARGET_20261101.md` явно зафиксированы Solana-only, `solana:<mint>` и запрет на EVM/Bitcoin в новых событиях. Не расширять `CHAINS` и wire contracts до multichain в рамках этого плана. Если бизнес-требование изменится — сначала отдельный ADR с chain identity, finality, reorg и migration policy.
2. X и Telegram — evidence sources, не blockchain networks. Stable identity — numeric platform IDs; handles/usernames — изменяемые атрибуты.
3. X Collector, TG Collector и Solana Launcher остаются владельцами своих source stores. Node Intelligence — отдельный cross-source consumer/read model. Никаких прямых записей в чужие source tables.
4. Python Intelligence остаётся отдельным document/provider ingestion и scoring runtime. Не переименовывать его в Node Intelligence и не смешивать их storage/lifecycle.
5. Delivery semantics: at-least-once + idempotent Inbox + replay + DLQ. Не обещать exactly-once.
6. Raw evidence неизменно и отделено от интерпретаций. AI не может создавать/изменять факты, evidence, identity links или финансовые операции.
7. Coverage и freshness — обязательные атрибуты аналитического результата. Отсутствие данных не равно нулю.
8. Все DB изменения — additive migrations; уже применённые миграции не редактировать.
9. Никакого включения source outbox flags, production migrations, scraping sessions или deploy в рамках архитектурных PR без отдельного operator approval и runbook.

## 3. Что уже найдено в коде (предварительный аудит 2026-11-12)

| Область | Уже существует | Остаётся доказать / реализовать |
|---|---|---|
| Canonical IDs | `packages/contracts/src/canonical-ids.ts`: Solana mint/wallet и X/TG numeric IDs | Formal event envelope/schema registry, compatibility policy и contract test matrix |
| Evidence/time | `evidence.ts`, `timeline.ts`: observedAt/occurredAt, provider/parser/raw pointer | Uniform event envelope, raw evidence retention reference and schema compatibility rules |
| Outbox/Inbox | `packages/event-outbox`, `intelligence/src/delivery.ts`, fingerprint migration 017, revision invalidation 018 | End-to-end fault matrix, DLQ operator workflow, real-source canary/replay proof; supervisor is local/foreground, not a managed production service |
| Identity | `entity_registry` + `entity_evidence` and verified token-link evidence | Separate evidence-weighted entity-link model, conflict resolution, decay, transitivity constraints, manual override/revoke audit |
| Feature Store | Migration 003, immutable `feature_versions`, as-of snapshots; migration 006 cross-platform aggregates | Per-feature lineage to exact input event IDs, formula/window/update/null semantics and reproducible recomputation |
| Coverage | Migration 006 `source_coverage_windows`, quality/coverage work and UI/API pieces exist | Make coverage a required join/guard for every report/feature/signal; source scope and completeness evidence must be explicit |
| Correlation | `token_correlations` stores statistical event/outcome correlations | Distinguish deterministic entity/evidence matching from statistical association; define matching rules, time windows, negative evidence and false-positive controls |
| AI governance | Migrations 009/010/012, AI cost ledger/shared budgets, grounding and validation code | Verify circuit breakers, cache invalidation, provider fallback, strict tool isolation and untrusted-input prompt-injection controls |
| Backtesting | Temporal/as-of queries, preregistration and validation gates exist | Prove no look-ahead/leakage, point-in-time universe, walk-forward and survivorship-bias tests |
| SLA/operations | Supervisor emits local health snapshots and thresholds | Formal per-source freshness SLO, stale/degraded states, external alerting and owner/runbook |

Этот инвентарь — статический аудит файлов ветки. Он не доказывает работу реальных X/TG/RPC источников, production DB, внешнего мониторинга или полноту исторического сбора.

## 4. План по этапам

### Этап 0 — Baseline и безопасность изменений

**Работы**
- Зафиксировать точный PR HEAD, base и список changed files.
- Сопоставить текущие документы AS-IS, TARGET, DATA_CONTRACTS и фактические source files.
- Выделить существующие реализации и не создавать дублирующие модули.
- Сохранить source outbox flags default-off; не выполнять deploy/merge.
- Составить test register: unit, contract, PostgreSQL integration, source adapter, fault injection, live canary.

**Приёмка**
- Есть карта компонентов, владельцев данных, БД и runtime.
- Каждый вывод имеет ссылку на файл/тест/миграцию.
- Неизвестное помечено UNKNOWN, а не PASS.
- Нет несанкционированных production действий.

### Этап 1 — Shared Contracts + Schema Registry (P0)

**Работы**
- Инвентаризировать `packages/contracts`, `packages/event-outbox` и X/TG/Solana producer payloads.
- Ввести единый envelope: `eventId`, `sourceSystem`, `eventKind`, `schemaVersion`, `eventKey`, `occurredAt`, `observedAt`, `knownAt`, `entityRefs`, `evidenceRefs`, `payload`, `payloadSha256`, `producerVersion`.
- Зафиксировать event identity и hash canonicalization; различать duplicate и same-key/different-payload collision.
- Определить JSON Schema/TypeScript contract registry, compatibility modes (backward/forward/full) и правила deprecation.
- Для Solana event envelope зафиксировать `chain='solana'`, cluster/genesis identity, signature, slot, blockhash/parent context, commitment/finality observation и source provider. Не добавлять EVM fields как фиктивные optional значения.
- Сохранить три времени: occurredAt (источник), observedAt (collector), knownAt/ingestedAt (Intelligence). Время должно быть UTC ISO-8601.
- Определить retract/edit/revision semantics для X/TG сообщений и chain evidence revisions.

**Приёмка**
- Все producers и consumers валидируют один и тот же versioned envelope.
- Golden fixtures для X, TG, Solana проходят на producer и consumer сторонах.
- Неизвестная schema version и несовместимое изменение отвергаются fail-closed.
- Hash стабилен к порядку JSON object keys, но меняется при смысловом изменении payload.
- Contract tests проверяют clock ordering, entity/evidence consistency и event-key collision.
- Документация generated from/checked against source schema; ручной drift ловится CI.

### Этап 2 — Event Pipeline (P0)

**Работы**
- Проверить atomic source row + outbox write для каждого producer.
- Проверить claim leases, fencing tokens, renewal, ACK-after-destination-commit.
- Уточнить DLQ state machine: reason code, attempt count, first/last failure, next retry, payload hash, operator disposition.
- Реализовать безопасный replay по event ID/range с dry-run, rate limit и audit trail.
- Добавить fault injection: падение до commit, после commit до ACK, потеря lease, повторная доставка, poison event, destination outage, source outage.
- Контролировать queue lag, oldest pending age, retry/DLQ и delivery latency.
- Не вводить message broker без измеренной необходимости: текущий прямой outbox/inbox transport — допустимая начальная архитектура.

**Приёмка**
- Ни один source event не теряется при перечисленных crash points.
- Повторная доставка даёт один logical effect.
- Same event key с другим payload даёт collision/DLQ, а не молчаливый ACK.
- Replay восстанавливает целостный результат и не дублирует сущности/таймлайн.
- У каждого источника независимый backlog и возможность остановки.
- Есть operator runbook и воспроизводимый изолированный PostgreSQL integration test.

### Этап 3 — Data Coverage & Freshness Service (P0)

**Работы**
- Использовать существующую `source_coverage_windows` как базу, не создавать второй реестр без необходимости.
- Определить coverage по source + scope + time window + knownAt + collection method.
- Разделять `complete`, `partial`, `unknown`, `unavailable`, `stale`; документировать точное значение каждого состояния.
- Ввести watermark: last observed event, last successfully scanned cursor, oldest pending, gap intervals, provider/API limits.
- Распространить coverage metadata на feature snapshots, correlation outputs, AI reports и alerts.
- Запретить трактовать отсутствие записей как нулевую активность, если coverage не complete.
- Сформировать per-source freshness SLO и degraded-mode policy.

**Приёмка**
- Любой аналитический ответ показывает coverage status, time window, as-of/known-at и lag.
- При пропуске данных результат помечается partial/unknown, а confidence не маскирует неполноту.
- Тесты доказывают, что пустой результат при unknown coverage не возвращает «0 mentions/trades».
- Просроченный источник переводит результат в STALE/DEGRADED, а не в полный PASS.

### Этап 4 — Identity Resolution (P1)

**Работы**
- Разделить canonical entities и probabilistic links: совпадение аккаунта/кошелька не должно менять canonical ID.
- Создать versioned `entity_links` / `identity_assertions` с source/target, relation, evidence IDs, feature contributions, score, confidence, algorithm version, valid time, observed time, status.
- Начать с правил, не с LLM: exact public wallet declaration, cryptographic signature proof, verified mint mention, source-owned IDs. Similarity/temporal/behavioral признаки — только дополнительные.
- Задать calibration set и веса; score должен быть объяснимым, калиброванным на размеченных примерах, а не произвольным процентом.
- Статусы: proposed, supported, confirmed, rejected, revoked, disputed. Разделить score и human decision.
- Запретить автоматическую транзитивность; отдельные relation-specific rules и допустимые paths.
- Ввести conflict detection, manual split/revoke, audit history, appeal/review.
- Confidence decay применять только к временным/поведенческим сигналам; криптографические и immutable evidence не должны «стареть» тем же способом.
- Не связывать реальных людей между платформами по слабым признакам; только публичные/разрешённые доказательства и минимизация персональных данных.

**Приёмка**
- Unit tests на веса/пороги/конфликты/decay/transitivity.
- Один и тот же набор evidence даёт воспроизводимый результат при одинаковой algorithm version.
- Ручной revoke немедленно исключает связь из downstream read models и инициирует invalidation.
- Нельзя получить confirmed link из одного совпадения имени, времени или ticker.
- False-positive rate измеряется на размеченной holdout выборке.

### Этап 5 — Feature Store и lineage (P1)

**Работы**
- Сохранить immutable `feature_versions`; определения сделать полными и машиночитаемыми.
- Для каждого feature задать entity type, formula/code version, input event kinds, aggregation window, timezone, update cadence, freshness TTL, null/missing policy, coverage requirement.
- Хранить lineage как компактные ссылки на точные event/evidence IDs или на проверяемые lineage batches + content hash; не копировать весь raw payload.
- Различать event time, observed time, feature as-of time и computed/published time.
- Ввести invalidation/recompute при edit/delete/retraction, identity revoke, late arrival и formula change.
- Разделить raw, derived и model-generated features.

**Приёмка**
- Любое значение можно объяснить набором входных event IDs, кодом/версией формулы и окном.
- Повторный расчёт на тех же inputs даёт тот же результат.
- Late-arriving input не переписывает исторический as-of snapshot задним числом.
- Missing/unknown остаётся NULL/unknown, не превращается в ноль.
- Изменение формулы создаёт новую feature version.

### Этап 6 — Correlation Engine + Knowledge Graph (P1)

**Работы**
- Разделить три разных результата: evidence link (прямая доказанная связь), temporal/behavioral candidate (гипотеза), statistical association (корреляция outcome).
- Для каждого matcher определить признаки, окно времени, обязательные доказательства, negative evidence, threshold, coverage prerequisite и false-positive cost.
- Правила первого релиза: literal mint in source text + mint proof; exact wallet in verified public source; exact event/transaction reference; temporal proximity только как weak candidate.
- Не выводить причинность из временной близости.
- Сохранять matched evidence, rejected candidates, algorithm version и объяснение.
- Graph edges должны иметь тип, provenance, valid time, confidence, status; graph traversal не должен автоматически повышать confidence транзитивно.
- Ввести ручной review queue для спорных и высокорисковых связей.

**Приёмка**
- Набор позитивных и негативных fixtures для каждого matcher.
- Никакой корреляции без Evidence IDs и coverage.
- Temporal-only match никогда не становится confirmed.
- Граф можно пересобрать из versioned evidence/edges.
- Ручное снятие edge инвалидирует downstream features, alerts и reports.

### Этап 7 — Deterministic Intelligence + Backtesting (P1)

**Работы**
- Перенести scoring в детерминированные versioned functions.
- Разделить descriptive score, risk score, evidence confidence и forecast probability.
- Пререгистрировать signal definition, universe, threshold, horizon и evaluation protocol до holdout.
- Применять chronological split / walk-forward; запрещать случайное перемешивание временных рядов.
- Universe membership должен быть point-in-time: включать delisted/failed/abandoned tokens, а не только выжившие.
- Использовать только features, published/known до decision time; label window начинается после decision time.
- Учитывать fees, slippage, liquidity constraints, unavailable data, token migrations и survivorship.
- Отчёты показывают sample size, confidence intervals, base rate, missingness, coverage и calibration.

**Приёмка**
- Synthetic leakage tests специально подсовывают future data и должны падать.
- Walk-forward и untouched holdout запускаются отдельно.
- Нельзя включить production alert по одной красивой in-sample метрике.
- Результат backtest воспроизводим по dataset snapshot, code commit и model/feature versions.

### Этап 8 — AI Orchestrator и prompt security (P2)

**Работы**
- Сначала read-only tools над validated Intelligence API; никаких прямых SQL/DB credentials у агентов.
- Недоверенные X/TG/web content передавать как quoted data objects с явными untrusted labels; никогда не конкатенировать как system/developer instructions.
- Role separation: policy/system instructions отдельно, source content отдельно, tool outputs отдельно.
- Инструменты выбирает orchestrator по allowlist; содержимое поста не может инициировать tool call, shell, URL fetch или внешнее действие.
- Ограничить network egress, tool permissions, payload size, recursion, timeouts и per-task budget.
- Shared budget/reservations, per-provider circuit breaker, bounded retries, fallback на deterministic report.
- Кэшировать по input evidence hash + prompt version + model version + policy version; invalidation при edit/delete/evidence revoke.
- Validate structured outputs против schema; unsupported claims без evidence отклонять.
- Модельные ответы и prompt traces не должны утекать секретами/полными личными сообщениями в логи.

**Приёмка**
- Prompt-injection corpus: «ignore previous instructions», tool injection, data exfiltration, nested JSON/HTML и encoded payloads — не вызывают инструментов и не меняют policy.
- Provider outage / 10x cost / malformed output / timeout дают bounded fallback.
- Budget reservations не превышают лимит при параллельных workers.
- AI report не может изменить source evidence, identity status, feature snapshots или alerts policy.

### Этап 9 — API/UI и контролируемый rollout (P2)

**Работы**
- Read-only API для token/project/wallet/account/timeline/graph/evidence/coverage.
- UI показывает источники, coverage, freshness, evidence, uncertainty, as-of и модельную версию.
- Сигналы по умолчанию shadow-only; включение уведомлений только после validation gates.
- Canary на ограниченном operator-approved наборе источников и сущностей.
- Runbooks: pause source, replay, DLQ review, invalidate/recompute, restore.
- Отдельно планировать managed process supervisor/monitoring; текущий foreground supervisor не выдавать за production daemon.

**Приёмка**
- UI не скрывает partial/stale/unknown coverage.
- Все AI statements раскрывают evidence и unsupported/uncertain fields.
- Canary можно остановить без потери исходных данных и без изменения source DB schema.
- Есть измеренные ingestion lag, delivery latency, error rate, DLQ age, coverage и RPO/RTO.

## 5. Общие Definition of Done

Этап не считается завершённым, пока одновременно не выполнено:

- Изменения имеют тесты на позитивные, негативные и граничные случаи.
- DB migrations additive, протестированы на пустой и предыдущей схеме.
- Retry/replay/idempotency проверены интеграционно.
- Есть structured logs/metrics без секретов и raw private content.
- Обновлены AS-IS/TARGET/KNOWN_GAPS и operator runbook.
- CI пройден на точном HEAD; skipped/queued не считаются pass.
- Нет незадокументированных live side effects.
- Независимый review закрывает замечания.
- Production readiness заявляется отдельно от CI readiness.

## 6. Приоритетный backlog и контрольные точки

| ID | Приоритет | Результат | Блокирует следующий этап |
|---|---|---|---|
| PI2-000 | P0 | Baseline inventory + test register | Да |
| PI2-010 | P0 | Shared event envelope/schema registry | Да |
| PI2-020 | P0 | Contract compatibility + producer/consumer fixtures | Да |
| PI2-030 | P0 | Outbox/Inbox/DLQ/replay fault matrix | Да |
| PI2-040 | P0 | Coverage/freshness service contract and enforcement | Да |
| PI2-050 | P1 | Evidence-weighted identity links | Да |
| PI2-060 | P1 | Feature definitions + lineage | Да |
| PI2-070 | P1 | Correlation rules + graph edges | Да |
| PI2-080 | P1 | Deterministic scoring + leakage-safe backtesting | Да |
| PI2-090 | P2 | AI orchestration, budget, fallback, prompt isolation | Да |
| PI2-100 | P2 | Read-only UI/API and controlled canary | Финал |

## 7. Текущий статус работ

- [x] Статически проверены основные shared contracts: canonical IDs, evidence, entity refs, timeline, verified token links.
- [x] Добавлен исполняемый план [POTAPOFF_INTELLIGENCE_V2_IMPLEMENTATION_PLAN.md](POTAPOFF_INTELLIGENCE_V2_IMPLEMENTATION_PLAN.md).
- [x] Добавлена спецификация [SHARED_CONTRACTS_V2.md](SHARED_CONTRACTS_V2.md); в PR реализован первый runtime contract layer V2, producers пока сохраняют V1.
- [x] Проверены базовые outbox/inbox delivery semantics и payload fingerprint/revision migrations.
- [x] Подтверждено наличие immutable feature versions и as-of snapshot constraints.
- [x] Подтверждено наличие coverage windows, AI budget tables, temporal validation/preregistration.
- [x] Зафиксировано архитектурное ограничение: Solana-only; multichain не входит в текущий target.
- [x] Выполнен первичный статический контрактный gap analysis X/TG/Solana producers; обнаружено отсутствие централизованного schema registry и compatibility policy. См. [SHARED_CONTRACTS_V2.md](SHARED_CONTRACTS_V2.md).
- [x] Добавлены Event Envelope V2 types, canonical JSON/SHA-256, deterministic event ID, runtime validator и source-controlled registry для десяти текущих X/TG/Solana event schemas.
- [x] Добавлены JSON Schema drift, compatibility-policy, immutable schema-ID, replay/collision и V1 normalizer unit tests.
- [x] Добавлен CI integration test, который вызывает фактические V1 builders X/TG/Solana и прогоняет их через общий V2 registry; результат ожидает проверки на точном HEAD.
- [x] Подтверждён exact-head CI для Shared Contracts и source-producer compatibility: 30 успешных workflows, 0 failed, 1 skipped (не засчитан как pass).
- [x] Добавить source outbox `created_at` в `ClaimedEvent` PostgreSQL/SQLite adapters; PostgreSQL emission использует `clock_timestamp()` в момент вставки.
- [x] Подключить V1/V2 dual-read в Intelligence delivery без изменения V1 knownAt/fingerprint semantics; V2 hash используется для replay/collision.
- [ ] Добавить producer-specific V2 builders behind default-off flags; текущие producers остаются V1.
- [ ] Завершить полные parity fixtures V1/V2 для X/TG/Solana и проверить их на точном CI HEAD.
- [ ] Выполнить pipeline fault matrix и operator DLQ/replay proof.
- [ ] Превратить coverage в обязательный gate для features/correlations/AI reports.
- [ ] Реализовать evidence-weighted identity links.
- [ ] Добавить lineage и matcher rules.
- [ ] Закрыть backtest leakage и AI security tests.

## 8. Запреты для этой программы

- Не расширять сеть за пределы Solana без ADR.
- Не включать live collectors/outbox flags без отдельного подтверждения оператора.
- Не мигрировать production DB и не менять credentials.
- Не делать merge/deploy в рамках исследовательских и архитектурных этапов.
- Не считать синтетические fixtures доказательством реальной полноты источника.
- Не добавлять Kafka/ClickHouse/Neo4j/vector DB «на будущее» без измеренного bottleneck и ADR.
- Не создавать второй event registry, coverage service или feature store, пока существующий компонент можно расширить безопасно.

---


### Обновление consumer dual-read — 2026-11-12

- [x] `ClaimedEvent.createdAt` добавлен в PostgreSQL и SQLite claim adapters; отсутствующий/невалидный timestamp откатывает claim до фиксации lease.
- [x] V1 registered events проходят адаптер с `emittedAt = source created_at`; unknown legacy events и read-only snapshots сохраняют прежний V1 путь.
- [x] V2 envelope валидируется, его outer identity и `emittedAt` сверяются с outbox row.
- [x] V1 fingerprint и source evidence clocks остаются прежними; `knownAt` не подменяется `emittedAt`.
- [x] V2 полный envelope hash используется для duplicate/collision detection.
- [x] Добавлены focused delivery tests на missing created_at, V1 knownAt parity, V2 hash tampering, identity mismatch, replay и collision.
- [x] Подтверждён exact-head contracts/outbox/Intelligence CI: 30 успешных workflows, 0 failed, 1 skipped (не засчитан как pass).


**Cutover blocker:** V1 inbox fingerprints remain registry-only for replay compatibility; V2 inbox fingerprints are full-envelope hashes. Same-key V1→V2 replay is deliberately rejected as `identity_collision` until an explicit cross-version reconciliation/cutover design is implemented and tested. Do not enable V2 producers or rewrite existing outbox payloads before that gate is closed.


- [ ] До любого live consumer canary проверить pending X/TG outbox rows: исторический `created_at DEFAULT now()` может предшествовать `observedAt`; не переписывать source rows автоматически. При несовместимых строках нужен отдельный операторский план reconciliation.


- [ ] До live consumer canary проверить pending исторические Solana SQLite outbox rows: старый writer копировал `observedAt` в `created_at`; новый writer фиксирует wall-clock insert time. Не переписывать исторические строки и не выводить `emittedAt` из payload.


### CI checkpoint — 2026-11-13

- [x] На точном PR HEAD `3fe5ead99b5ee01d33bf887f55e87af25af595e0` завершились 30 workflows успешно.
- [x] Неуспешных workflows: 0.
- [ ] Независимое review: reviews и inline review threads пока отсутствуют.
- [ ] Cross-version V1/V2 replay reconciliation: подготовлен безопасный additive design в `SHARED_CONTRACTS_V2.md`, код и PostgreSQL concurrency tests ещё не реализованы.
- [ ] Исторические pending source rows X/TG/Solana: только read-only операторская инвентаризация; source rows не переписывать.
- [ ] V2 producer builders/parity/fault matrix/coverage enforcement остаются открытыми.
