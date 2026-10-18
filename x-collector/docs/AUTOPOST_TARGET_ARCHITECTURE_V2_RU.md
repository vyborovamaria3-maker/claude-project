# X Autoposting v2: утверждённая целевая архитектура

> **Статус: ACCEPTED TARGET (техническое решение).** Этот файл закрепляет будущую архитектуру; он НЕ означает, что v2 уже реализована.
> Дата: 2026-10-19. Основа для сверки: ветка `fix/x-autopost-reliability-20261018`, PR #127, commit `9c38189d5a3596ae7b6ac0a4b7027b84efae29a4`.
> Запуск: **локально на ноутбуке**. Сервер и Redis не требуются. План: [AUTOPOST_IMPLEMENTATION_PLAN_V2_RU.md](AUTOPOST_IMPLEMENTATION_PLAN_V2_RU.md).

## 1. Неизменяемые правила

1. `attempted=false` — возможен только безопасный, классифицированный retry до необратимого действия. `attempted=true` — нельзя повторять внешнюю операцию без подтверждения, что она не состоялась. Статус `uncertain` является защитой от дублирующей отправки.
2. Состояние задания, попытки и событие перехода фиксируются согласованно в PostgreSQL. Транзакция базы **не может** сделать сетевое действие X атомарным; неопределённость разрешается reconciliation или ручным подтверждением.
3. Текущее состояние и аудит — разные сущности: `xc_auto_jobs` (state), `xc_auto_reconcile` (active reconciliation), будущие `xc_auto_job_attempts` и `xc_auto_job_events` (append-only audit). Не применять полное event sourcing.
4. Подтверждённая публикация (`published`) и успешная синхронизация статистики — независимые состояния.
5. Отрицательное наблюдение like/repost/follow **не** означает достоверно неотправленное действие и не разрешает автоматический retry.
6. Никаких обходов CAPTCHA, блокировок, лимитов X; никаких живых публикаций без отдельного разрешения владельца.
7. `CI: passed` отдельно от `Live X: not tested/passed/failed`. CI не подтверждает реальную авторизованную сессию.

## 2. Существующая архитектура (AS-IS, по коду PR #127)

```text
solana-launcher/app/settings/AutopostPanel.tsx
     -> Next.js /api/integrations/x-collector/route.ts (auth, Origin, local)
     -> solana-launcher/lib/xcollector-autopost.ts (Node.js IPC)
     -> x-collector/scripts/autopost/engine.cjs
     -> store.cjs / providers.cjs (AI + planner + enqueue)
     -> PostgreSQL: xc_auto_jobs, xc_auto_config, xc_ai_providers
     -> scripts/autopost-worker.cjs (один последовательный Worker)
     -> queue.cjs (атомарный claim job + publisher account)
     -> browser.cjs (Playwright, сессия, proxy, X)
             -> published -> xc_auto_posts + xc_auto_metrics + twitter_tweets
             -> failed
             -> uncertain -> xc_auto_reconcile -> reconciliation.cjs
                           -> resolved | очередная проверка | ручное решение
```

Текущие действия: `post`, `reply`, `like`, `repost`, `follow`. Автоматическая сверка реализована для post/reply, где сравниваются автор, текст, время, а для reply — ID родительского твита. Граница matching от 30 секунд до попытки до 5 минут после неё, повторные наблюдения — до 24 часов. Для engagement actions пока только ручное решение.

В базе `xc_auto_jobs.id TEXT PRIMARY KEY`, `xc_auto_reconcile.job_id TEXT PRIMARY KEY REFERENCES xc_auto_jobs(id) ON DELETE CASCADE`. Временные поля — `BIGINT` миллисекунды. Есть `UNIQUE(dedup)` без дневного срока; PostgreSQL advisory lock `742098531`; heartbeat обновляется внутри основного `cycle()`, UI считает его свежим до 10 минут. В SQL выборка первых 20 jobs идёт по scheduled time до поиска ручного задания.

**Не реализовано на указанном SHA:** append-only попытки/события, единая транзакционная финализация, автоматическая сверка like/repost/follow, независимый heartbeat, health компонентов, приоритет в SQL, circuit breaker, time-scoped dedup.

## 3. Новая схема выполнения (TO-BE)

```text
Content sources -> AI planner / manual -> validated PostgreSQL job
     -> claim(account + job) -> CREATE attempt + event
     -> prepare Playwright / verify publisher identity and limits
     -> persisted attempted boundary + event
     -> perform X action outside PostgreSQL transaction
        |
        +--> confirmed -> finalizeOutcomeTx -> published + audit event
        |                              -> metrics sync independently
        +--> uncertain -> reconciliation worker
                           |
                           +--> post/reply: strict profile/timeline matching
                           +--> like/repost/follow: verified state observation
                           |
                           +--> present & unique -> finalizeOutcomeTx
                           +--> absent/unknown -> recheck -> manual review
```

Planner и AI-провайдеры сохраняют ограничения текущей версии: валидированные источники, JSON actions, ограничения длины, дневные лимиты и запрет вымышленных ссылок. Модель не управляет Playwright напрямую. Улучшенный fact-check, prompt versioning и feedback loop — отдельный будущий этап.

Очередь продолжает соблюдать один активный action на аккаунт. Новое поле `priority` необязательно на первом этапе, но SQL должен выбирать ручное задание до LIMIT; любое изменение планировщика не обходит account lock, расписание и условия разрешения.

## 4. Целевые таблицы и миграции

| Таблица | Статус | Назначение |
|---|---|---|
| `xc_auto_jobs` | существует | Текущее состояние, граница `attempted`, origin, result, dedup |
| `xc_auto_reconcile` | существует | Текущая сверка по `job_id`; добавить связь с активной попыткой |
| `xc_auto_job_attempts` | **новая** | `attempt_id TEXT`, `job_id TEXT`, `attempt_no`, времена, error category/code, trace_id; unique `(job_id,attempt_no)` |
| `xc_auto_job_events` | **новая** | Append-only `event_id`, job/attempt FK, `event_type`, epoch-ms, `payload JSONB`; индекс `(job_id,event_id)` |
| `xc_auto_worker_health` (либо аддитивные поля control) | **новая** | heartbeat, worker ID, состояния/прогресс planner/publisher/reconcile/sync |
| `xc_auto_posts`, `xc_auto_metrics`, `xc_auto_sync` | существуют | Сохранённые публикации, метрики и отдельная синхронизация |

Номер попытки увеличивается при каждом фактическом новом исполнении, включая разрешённый оператором повтор. `origin` остаётся `manual/agent`: retry — свойство attempt, а не источник задания. Старые events не переписывать, не сохранять секреты/cookies/API tokens в JSON audit. Выбрать явные retention и FK policy, не удалять важную историю каскадом без решения.

**Дневная дедупликация:** `scheduled_at` — BIGINT, не TIMESTAMPTZ; выражение `DATE(scheduled_at)` некорректно для нужного ограничения. Предусмотреть отдельный рассчитанный `dedup_day DATE` или эквивалентную bucket-политику с `content_hash`. Старый уникальный `dedup` заменять только с идемпотентной миграцией и тестами обратной совместимости, особенно для неопределённых попыток.

Миграции автопостинга сейчас применяет `scripts/setup-autopost.cjs` через `scripts/autopost/schema.sql`; это отдельная схема от общего манифеста X Collector. До внедрения проверить двукратный прогон, бэкап, независимую тестовую PostgreSQL и поведение существующих jobs.

## 5. Финализация, ошибки и восстановление

Разделить существующую `persistPost()` на `persistPostTx()` без собственных BEGIN/COMMIT и обратносуместимую внешнюю обёртку. Новая `finalizeOutcomeTx()` в **одной** транзакции: idempotent post upsert -> guarded job status -> reconciliation status -> append-only audit event. Сеть X всегда снаружи SQL-транзакции. Ошибка БД при записи результата вызывает повтор сохранения/сверки, **не** повтор X-клика.

Категории: `X_ERROR`, `DB_ERROR`, `VALIDATION_ERROR`, `PROCESS_ERROR`. Отдельно сохранять код ошибки и решение. Ошибку PostgreSQL нельзя считать отсутствием опубликованного твита. Повторный finalize по тому же подтверждённому result должен быть идемпотентным.

Стадии `created`, `claimed`, `preparing`, `attempted`, `confirmed`, `reconciled`, `failed`, `retried` — **аудит**, а не доказательство, что X завершил операцию. Перезапуск Worker не ставит `attempted=true` обратно в `queued`. Таймаут локальной IPC-команды не меняет состояние публикации автоматически.

Сверка like/repost/follow — только read-only observation ожидаемого publisher профиля и цели (`unlike`/`unrepost`/`unfollow`). Уверенное положительное состояние разрешает результат; отрицательное, неоднозначное и недоступное ведёт к дополнительной проверке или `manual_review/manual_required`, не к публикации/лайку повторно.

Ручной retry требует существующее `confirmed_not_performed=true`, создаёт отдельную attempt и предупреждает оператора о риске дубля при недостаточном доказательстве. Текущий job статус и immutable audit пишутся одной транзакцией.

## 6. Мониторинг, безопасность и масштабирование

Heartbeat вынести в отдельное PostgreSQL-соединение с таймаутом и защитой от параллельных heartbeat-запросов: ориентир интервала 30 сек, TTL 90–120 сек после испытаний. Состояния UI `online/idle/busy/stalled/offline`; отсутствие публикаций при пустой очереди — `idle`, а не `dead`. Отдельные показатели planner/publisher/reconcile/sync, операционные счётчики queued/uncertain/review и возраст oldest job.

Circuit breaker аккаунтов и AI на основе типизированных ошибок. При challenge/rate-limit соблюдать ограничения X и требовать ручной проверки; не заменять аккаунт или прокси для обхода. Новые паузы содержат причину и время возобновления.

`MASTER_KEY` (AES-256-GCM) менять только после инвентаризации **всех** шифротекстов, резервной копии и тестовой ротации. Существующие auth, localhost и Origin ограничения API сохранить; вопрос CSRF решать по модели угроз.

Advisory lock в одной PostgreSQL уже защищает также от процессов на разных машинах с этой же БД. Redis и много browser workers не входят в локальную v2 без отдельного решения и измерений.

## 7. Принятые архитектурные решения

**Принято:** `attempted` как граница, immutable audit, отдельный attempt ID, atomic/idempotent финализация, раздельные DB/X ошибки, безопасная сверка engagement, независимый heartbeat, локальная PostgreSQL.

**Отклонено:** «not_found -> auto retry», слепой возврат running -> queued после IPC timeout, `origin=retry`, обязательный Redis, `clicked` как достоверная гарантия, безусловный retry `TARGET_NOT_FOUND`/`PRE_SEND_FAILED`.

**Отложено:** полный event sourcing, 10 параллельных браузеров, переключение AI без пользовательской политики, расширение match window без надёжных идентификаторов и ML feedback loop.

## 8. Проверка и контроль изменений

Необходимо: unit + PostgreSQL multi-client integration; fault injection между persisted post, job status и event; crash до/после attempted; два оператора одновременно; Playwright mocks (все 5 видов действий, present/absent/unknown); backward-compatible миграции; Next.js lint/build.

**Live X: not tested** до отдельного разрешения владельца на контролируемое действие и документирования результатов. Изменения архитектуры требуют обновить этот ADR, тесты и план. Не маркировать TO-BE как реализованное до отдельного кодового PR.
