# Blockchain AI Snapshot V1.0.1 — adversarial code review

## Scope

Повторно проверена полная цепочка `chain analysis -> DEV History -> AI snapshot -> compatibility transport -> AI report -> Blockchain UI`, включая cache/race semantics, source freshness, payload bounds, LLM runtime boundary и совместимость с существующим `social-snapshot-v5` transport.

## Закрытые дефекты

### High

1. **Source-time skew был невидим модели.** DEV History и chain analysis собираются независимо, но compact snapshot раньше не сохранял DEV/evidence timestamps. Добавлены `fetchedAt`, `ageMs`, `futureByMs`, `sourceTimes` и skew/staleness warnings.
2. **Stale DEV fallback выдавался за свежий.** При live-failure fallback cache получал `fetchedAt=now`. Теперь timestamp берётся из persisted DEV evidence.
3. **Coverage scale была неоднозначной.** В `AiFact.coverage` смешивались share01 и percent100. AI facts теперь используют только `share01` и явно маркируют scale.
4. **Historical creator truth мог раздваиваться.** V1 creator history и DEV History V3 могли расходиться в одном snapshot. При доступном DEV History он канонический; V1 — только fallback.
5. **Cache invalidation race.** Старый in-flight analysis мог перезаписать новый cache и удалить новую in-flight запись. Добавлены generation + promise identity guards.
6. **UI mint-switch race.** Поздний AI response старого mint мог отобразиться под новым mint. Добавлены AbortController, request sequence и mint response check.
7. **Client abort не отменял upstream AI.** Abort теперь распространяется до model fetch; 45s timeout остаётся вторым guard.
8. **Unbounded compact payload.** Per-string/per-array limits не гарантировали общий размер. Добавлен hard budget 220 KB с deterministic standard/aggressive/emergency/minimal compaction и explicit metadata.
9. **AI не всегда получал весь compact snapshot.** Один 80 KB structured note молча обрезал большие snapshots. Теперь snapshot передаётся losslessly ordered chunks внутри `AnalysisSnapshot`-compatible features.
10. **Transport schema mismatch.** Custom blockchain object под `context.intelligenceSnapshot` мог быть отклонён strict upstream schema. Используется проверенный `social-snapshot-v5` / `entity-graph-v1.3` envelope.
11. **Fake Telegram evidence.** Control instruction передавалась как искусственное Telegram message. Удалено: `messages=[]`, report rules находятся только в structured snapshot/report-contract feature.
12. **Непроверенный `analysisMode=blockchain_deep`.** Заменён на уже рабочий `full_intelligence`; blockchain specialization остаётся в structured contract.
13. **Malformed LLM response мог сломать UI.** Server нормализует строки/массивы/risks/contradictions/confidence, пустой incompatible 200 считается provider failure.
14. **Required report sections терялись.** Section-specific output модели раньше отбрасывался normalizer'ом. Теперь сохраняется как `sectionReports` и может отображаться UI.
15. **AI report cache почти всегда промахивался.** DEV `fetchedAt` менялся при каждом сборе и попадал в fingerprint. Volatile freshness metadata исключена из semantic hash; аналитические значения остаются в hash.

### Medium / defensive

16. Regex mint validation заменена на реальный `PublicKey` round-trip.
17. Raw upstream/internal errors и полный snapshot больше не возвращаются клиенту при failure.
18. `chainHit` дополнен `cacheSource=cache|inflight|fresh`, чтобы in-flight dedupe не выдавался за completed cache.
19. DEV History failure теперь fail-soft и не уничтожает валидный chain snapshot.
20. LLM confidence нормализуется в `share01`: `0.95` и `95` -> `0.95`; вне `[0,100]` -> null.
21. Empty/malformed risk and contradiction rows не считаются usable AI content; `unknowns-only` report допустим при недостатке evidence.
22. Metadata ranges hardened: lifecycle confidence `[0,1]`, coverage/evidence completeness `[0,100]`.
23. Future DEV timestamps явно маркируются warning.
24. Whale/retail net-flow facts получили unit `SOL`.
25. Legacy `evidenceCompletenessPct` помечен как category-availability, а не sample coverage.
26. Compact drill-down truncation теперь виден модели и UI (`payloadTruncated`, `compactionLevel`).
27. Generic sanitizer защищён от `__proto__/constructor/prototype` keys и не пишет в `Object.prototype`.
28. Boolean `AiFact.value` корректно преобразуется в string в `IntelligenceFeature`, где boolean не разрешён типом.
29. Исправлен случайный duplicate `graphVersion` в compatibility object, найденный TypeScript diagnostic pass.
30. Structured UI section typing исправлен после TypeScript diagnostic pass.

## Evidence semantics retained

- `unknown != 0 != safe`.
- Partial evidence не становится положительным или отрицательным фактом.
- Funding relation не доказывает ownership.
- Coordination не доказывает insider control.
- Jito tip не доказывает atomic bundle.
- Confidence означает confidence evidence/interpretation, а не вероятность будущей доходности.
- Transport compaction всегда раскрывается явно и не выдаётся за полный raw drill-down.

## Remaining limitations

- Full workstation Next production build не заявлен: в execution tree нет точного project `node_modules`.
- AI provider schema проверяется через совместимый `social-snapshot-v5` envelope и regression contract, но реальный внешний provider не был доступен для end-to-end network call в этой среде.
- `detail=full` остаётся debug/lossless API и по определению может быть значительно больше compact payload; он находится за существующим `/api/trade` auth/rate-limit boundary.
