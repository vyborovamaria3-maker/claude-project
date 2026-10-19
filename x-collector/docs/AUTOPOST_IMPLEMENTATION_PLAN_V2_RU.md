# X Autoposting v2 — план внедрения и критерии приёмки

**Статус:** APPROVED ROADMAP — план, **не реализованный код**. Дата 2026-10-19. База: PR #127, SHA `9c38189d5a3596ae7b6ac0a4b7027b84efae29a4`.
Архитектура: [AUTOPOST_TARGET_ARCHITECTURE_V2_RU.md](AUTOPOST_TARGET_ARCHITECTURE_V2_RU.md). Работа только в локальной инфраструктуре пользователя; не изменять `main`/не делать merge без отдельного решения. Никакой реальной X-отправки без разрешения.

## Этап 0 — baseline / миграции / тестовая среда (P0)

Проверить текущие schema.sql, setup-autopost.cjs, статусы jobs, IPC/API permissions и полный список миграций X Collector. Подготовить disposable PostgreSQL, бэкап и rollback; зафиксировать SHA и CI. Не запускать существующий Worker вторым экземпляром.
**Критерий:** тестовая БД отделена от реальных сессий, схема применяется дважды, существующие записи сохранены, нет live X действий.

## Этап 1 — V2-01. Журнал попыток и событий (P0)

**Зависимость:** этап 0. **Файлы:** `scripts/autopost/schema.sql`, новый `job-audit.cjs`, `queue.cjs`, `browser.cjs`, `engine.cjs`, `autopost-worker.cjs`, tests.
Создать `xc_auto_job_attempts` c attempt ID, `attempt_no` и типизированной ошибкой; создать append-only `xc_auto_job_events` с минимальным безопасным JSON. Claim, boundary, uncertain, manual decision, finished и retry — события, записываемые транзакционно с изменением состояния. `origin=manual|agent` не менять.
**Критерий:** разные попытки одного задания сохраняются отдельно; replay/history показывает последовательность; concurrent claim не даёт одинаковые номера; rollback не оставляет ложный event; в событиях нет секретов.

## Этап 2 — V2-02. Атомарная финализация + DB/X error taxonomy (P0)

**Зависимость:** V2-01. **Файлы:** `browser.cjs`, `autopost-worker.cjs`, `engine.cjs`, `reconciliation.cjs`, новый небольшой transaction helper, tests.
Извлечь `persistPostTx` из текущего persistPost, сохранить прежнюю API-обёртку. Добавить `finalizeOutcomeTx`: идемпотентно сохранить подтверждённый пост, перевести job, завершить reconcile, создать audit — одним COMMIT. Отличать `X_ERROR`, `DB_ERROR`, `VALIDATION_ERROR`, `PROCESS_ERROR` и коды SQLSTATE. DB retry применяется к сохранению, не к внешнему действию.
**Критерий:** инъекция ошибки на любом SQL шаге не оставляет противоречивые terminal states; повторный finalize не создаёт дублей; crash после X success не ведёт к второму send; manual confirm проверяет account/target.

## Этап 3 — V2-03. Автоматическая read-only сверка like/repost/follow (P0)

**Зависимость:** V2-02. **Файлы:** `browser.cjs`, `reconciliation.cjs`, `autopost-worker.cjs`, UI, тесты Playwright mocks.
Для like/repost/follow открыть точный target и проверить авторизованный publisher account. Наблюдения: `present`, `absent`, `unknown`. Положительное проверенное состояние -> confirmed. Отрицательное -> повтор только **наблюдения**, затем manual_review/manual_required; неизвестное/challenge -> безопасное ожидание/ручной разбор.
**Критерий:** для каждого kind есть тесты present/absent/unknown, чужого профиля и недоступного target; ни один отрицательный результат не вызывает повторной отправки X action.

## Этап 4 — V2-04. Отдельный heartbeat и component health (P1)

**Зависимость:** V2-01; можно выполнять после P0. **Файлы:** worker, schema, store overview, AutopostPanel.tsx, tests.
Heartbeat на отдельном PG connection раз в ~30 с с query timeout/без наложения. TTL измерять, начальный ориентир 90–120 с. Progress: planner/publisher/reconcile/sync last_started, last_completed, last_error, state. UI online/idle/busy/stalled/offline, очереди и предупреждения.
**Критерий:** долгий браузерный цикл не делает живой Worker ложным dead; отсутствие jobs отображается как idle; прекращение Worker видимо в пределах TTL.

## Этап 5 — V2-05. Приоритет SQL и управляемая дедупликация (P1)

**Зависимость:** V2-01. **Файлы:** store, worker, queue, schema, tests.
Перенести manual-first в SQL ORDER BY **перед LIMIT 20** и подтвердить план индексами через EXPLAIN. Добавить явный content_hash/dedup_day только после определения политики; учесть BIGINT epoch, текущий `UNIQUE(dedup)`, старые записи и защиту uncertain.
**Критерий:** manual job находится даже после 100 агентских; повтор enqueue сегодня не создаёт два задания; разрешённый повтор завтра допускается политикой; uncertain job не дублируется.

## Этап 6 — V2-06. Circuit breaker, паузы и ошибки AI (P1)

**Зависимость:** V2-02. **Файлы:** account-health.cjs, providers.cjs, schema, engine, store, UI, tests.
Separate breaker для аккаунта и AI. Предварительная политика только для тестов: 3 подходящие последовательные ошибки аккаунта -> 1 час; 5 ошибок AI -> 30 минут; состояния open/half-open/closed, причина паузы, безопасный reset. Ограничение X не обходится сменой прокси или аккаунта. AI fallback только по явной политике пользователя.
**Критерий:** повторяющийся отказ не превращается в цикл публикаций; причины и `resume_at` сохраняются, UI корректен.

## Этап 7 — V2-07. Ротация ключей и аудит безопасности (P1)

Инвентаризировать все AES-256-GCM шифротексты, зависящие от MASTER_KEY, включая X session и AI keys. Подготовить key-id/version, dry-run rotation, backup/rollback, тест на восстановление. Проверить текущую модель угроз API перед введением дополнительных CSRF-механизмов. Установить retention/log scrubbing.
**Критерий:** тестовая ротация проходит без потери данных; старые зашифрованные записи читаются во время контролируемого перехода; секреты не попадают в audit.

## Этап 8 — V2-08. Offline acceptance и разрешённый live smoke (gate)

Порядок: SQL migration twice -> unit/mocks -> PostgreSQL multi-client -> fault-injection -> frontend regression -> CI -> локальная ручная проверка -> отдельно согласованный тестовый X.
Команды из каталога x-collector:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run test:db
npm run test:postgres
```

Важно: `test:db` может быть пропущен, если нет TEST_DATABASE_URL; реальные интеграционные тесты должны покрывать именно autopost, а не только соседние подсистемы. Next.js UI проверять отдельными lint/build/test.
Live smoke: только после явного разрешения, один тестовый post на разрешённом аккаунте, проверка published, uncertain recovery, metrics; без второго автоматического send. Не выполнять живые действия из GitHub CI. Хранить раздельные результаты `CI: passed` и `Live X: not tested/passed/failed`.
**Критерий:** до прохождения и документирования live smoke нельзя утверждать, что реальная X-публикация проверена. Merge offline-кода не является разрешением на живые действия.

## Этап 9 — P2, только после замеров

Jitter для transient pre-send retry; разделение Worker на planner/publisher/reconcile/sync; ограниченная параллельность без пересечения аккаунтов; AI content quality/human review/prompt versions. Redis не нужен без отдельного ADR. Не повышать 3 AI actions per cycle до проверки качества.

## PR-последовательность и Definition of Done

| PR | Изменение | Зависимость | Состояние |
|---|---|---|---|
| V2-01 | Attempts + events + additive schema | Baseline | **В работе** — DB audit, trace correlation, typed publisher errors, tests/UI |
| V2-02 | Atomic finalization + typed errors | V2-01 | Не начато |
| V2-03 | Engagement reconciliation | V2-02 | **В работе** — read-only наблюдения и регрессионные mocks; live X не проверен |
| V2-04 | Heartbeat/health UI | V2-01 | Не начато |
| V2-05 | Priority + dedup | V2-01 | **В работе** — manual-first в SQL, дедупликация ещё не обновлена |
| V2-06 | Circuit breaker | V2-02 | Не начато |
| V2-07 | Secret rotation/runbook | Baseline | Не начато |
| V2-08 | Controlled live smoke | После P0 и CI | Не начато |

Каждый PR: миграция backward-compatible; rollback понятен; unit/PG/Next.js тесты; защита attempted; отсутствие секретов; актуальные README/ADR; нет автоматического merge в main. Этап V2-01 — первый кодовый шаг. Этот план **не является заявлением о выполненных изменениях v2**.

### V2-01: первый инкремент кода (автоматический DB audit)

Этот инкремент добавляет в `schema.sql` таблицы attempts/events, PostgreSQL-триггер переходов и локальную IPC-команду `audit`, а также SQL-тесты. Триггер охватывает изменения существующего runtime в той же транзакции без переписывания отправки.

Важно: старым заданиям **не приписывается** вымышленная история. Первое наблюдаемое событие появится только после установки схемы и нового перехода. `xc_auto_job_attempts` содержит обновляемую сводку текущей попытки; `xc_auto_job_events` — неизменяемый append-only журнал.

Осталось в V2-01 после первого инкремента: явная типизация ошибок в истории попыток, trace_id на всех слоях, тесты конкурентного исполнения на реальной PostgreSQL, операторский UI журнала. Эти пункты ещё не закрыты.

### V2-01: расширение аудита (инкремент 2)

- В `xc_auto_job_events.trace_id` хранится сквозная корреляция с конкретной попыткой (`xc_auto_job_attempts.trace_id`), созданной при claim.
- Ошибки browser-публикации классифицируются в `X_ERROR`, `DB_ERROR`, `VALIDATION_ERROR`, `PROCESS_ERROR`; сохраняются только категория и безопасный код, без текста исключения/секретов.
- Смена статуса, запись классифицированной ошибки и audit event выполняются в одной транзакции; для post-boundary `uncertain` не инициируется повторная отправка.
- Изменения статуса/числа проверок `xc_auto_reconcile` тоже создают события с тем же trace ID, но без необработанного содержимого X.
- Локальный интерфейс показывает trace ID и классифицированные ошибки; PostgreSQL integration тест проверяет корреляцию и конкурирующий claim.

Политика сроков хранения задокументирована в `AUTOPOST_AUDIT_RETENTION_RU.md`: автоматического удаления нет. V2-01 остаётся частично открытым для распределённой корреляции за пределами publisher browser; статус проверок всегда сверять с актуальным CI.


### V2-02: начальный транзакционный инкремент

- `scripts/autopost/finalize.cjs`: `finalizePublication()` атомарно обновляет `xc_auto_posts`, `twitter_tweets`, `xc_auto_jobs`, `xc_auto_reconcile` и audit events через триггеры.
- `browser.cjs`: `persistPostTx()` использует внешнюю транзакцию; старый `persistPost()` сохраняет совместимую обёртку. `inspectPublicationState()` сверяет сохранённый статус и точный ID твита после неоднозначного `COMMIT`; при конфликте повтор запрещён.
- `autopost-worker.cjs` и `engine.cjs`: автоматическое и ручное подтверждение публикаций используют тот же транзакционный механизм.
- `scripts/autopost/recovery.cjs`: восстановление после перезапуска Worker выполняется одной транзакцией. Попытки после send-boundary переводятся в `uncertain` и сверяются, а уже `published` задания не откатываются; истёкшие/неподдерживаемые действия требуют ручной проверки.
- `tests/autopost-finalization.test.ts` и `tests/autopost-recovery.test.ts`: идемпотентность, потерянный ACK `COMMIT`, rollback и переходы восстановления.
- `tests/integration/autopost-finalization.test.ts`: реальная PostgreSQL-проверка конкурентной финализации, неоднозначного `COMMIT` и rollback fault-injection.
- **Статус V2-02: основная реализация и проверки проходят CI на актуальном коммите; live X не проверен.** Следующий этап — V2-03: осторожная сверка лайков, репостов и подписок.


### V2-01: сохранность аудита

- [Принята политика хранения аудита](AUTOPOST_AUDIT_RETENTION_RU.md): автоматического удаления нет; рекомендуемая проверка объёма каждые 90 дней, минимальный горизонт расследования 180 дней; ручное архивирование возможно только после проверки восстановления и отдельного согласования.
- Таблицы защищены append-only trigger и `ON DELETE RESTRICT`; отказ SQL-аудита отменяет изменение статуса в той же транзакции.
- Это решение закрывает документирование retention, **не добавляет destructive GC**.

### V2-03: безопасное включение сверки engagement (инкремент)

- После неоднозначного исхода like/repost/follow задания переходят в `uncertain` с очередью `xc_auto_reconcile` вместо немедленного `manual_review` (это **не** повтор внешнего действия).
- Startup recovery тоже ставит допустимые и ещё не просроченные engagement jobs на read-only сверку. Неизвестные виды действий и истёкшие окна остаются на ручном решении.
- Проверка follow отвергает редирект на чужой профиль; состояние `performed` требует подтверждённого ID цели и отсутствия противоречивых кнопок.
- `tests/autopost-action-observation.test.ts` проверяет Playwright-compatible mock-профили, положительные/отрицательные/неоднозначные наблюдения, чужой профиль, недоступный target и отсутствие отправки.
- Прежние `manual_review` не массово переоткрываются: оператору нужно закончить их вручную. Никаких live X действий, слияния в main или обхода ограничений.
- **Статус:** изменение кода; проверять CI на SHA этого коммита. Live X: **NOT TESTED**.

### V2-05: приоритет ручных заданий (первый инкремент)

- `queue.cjs/dueJobs` выбирает задания с `ORDER BY CASE WHEN origin='manual' THEN 0 ELSE 1 END` **перед** `LIMIT 20`; фильтры разрешений и блокировки аккаунта сохранены.
- Добавлен частичный expression-index `xc_auto_jobs_manual_due` для `queued`. Его использование на большом объёме данных ещё нужно оценить через `EXPLAIN (ANALYZE, BUFFERS)` на отдельной тестовой PostgreSQL.
- Тест проверяет 120 агентских заданий перед ручным и отсутствие автоматических заданий при паузе. Никакой X-публикации.
- **V2-05 не закрыт:** дневная дедупликация и миграция старого `UNIQUE(dedup)` остаются отдельным этапом и требуют правил для uncertain/legacy.

### V2-04: независимый heartbeat и здоровье компонентов (инкремент)

- В `xc_auto_worker_health` хранится ID текущего Worker и heartbeat (30 секунд, TTL 120 секунд), в `xc_auto_component_health` — `planner/publisher/reconcile/sync`, начало/окончание и только безопасный код ошибки.
- `worker-health.cjs` открывает **отдельное** PostgreSQL-соединение, ставит statement/lock timeout и предотвращает наложение запросов. Ошибки подключения не прерывают публикацию; восстановление соединения пробуется на следующем тике. При штатном завершении heartbeat немедленно обнуляется.
- UI показывает `offline/idle/busy/stalled`, реальное количество очереди, количество uncertain и задач ручного разбора, возраст старейшего ожидающего задания и прогресс компонентов. `stalled` — выполнение компонента более 10 минут при свежем heartbeat; это наблюдение, не команда повторной отправки.
- Новые таблицы аддитивные, повторное применение миграций безопасно. Старое `xc_auto_control.heartbeat` оставлено для совместимости существующих клиентов, но больше не используется как индикатор жизни Worker в AutopostPanel.
- **Live X: NOT TESTED**; миграцию и эксплуатацию на реальной локальной PostgreSQL нужно отдельно проверить перед включением агента. Никаких обходов X, live-публикаций или merge.
