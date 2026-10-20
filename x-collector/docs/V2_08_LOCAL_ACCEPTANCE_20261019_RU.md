# V2-08: локальная offline-приёмка Windows — 19.10.2026

База проверки: PR #127, ветка `fix/x-autopost-reliability-20261018`,
коммит `64498c85329024a9c4024b63adc005cd5676bd11`.
Исправления сохраняются в этой же ветке. Merge в main не выполнялся.

## Изоляция

Для приёмки создана отдельная локальная копия ветки: найденные ранее рабочие
копии других веток и их незакоммиченные изменения сохранены.
Использован новый локальный PostgreSQL-кластер на `127.0.0.1:55432`,
базы `x_collector_v208_test` и `x_collector_restore_test`.
Рабочая служба PostgreSQL, рабочие ключи, `.env` и реальные X-сессии не менялись.
Дамп содержит только искусственные данные и хранится вне Git.
Удалённый runtime не использовался. Реальные действия в X не выполнялись.

Окружение: Node.js 24.18.0, npm 11.16.0, PostgreSQL 16.15,
TypeScript 5.9.3, Playwright 1.63.0, Next.js 16.4.0.
Зависимости collector установлены через `npm ci`; frontend — через
`npm ci --legacy-peer-deps`, как в существующих CI workflow.
Обычный frontend `npm ci` отклоняет существующий конфликт peer dependencies
HeroUI/Tailwind; lock-файлы для обхода не переписывались.

## Исправленные дефекты

1. SQL статистики автопостинга падал с PostgreSQL `42601` около `day`,
   поэтому реальный API отвечал HTTP 400. Добавлен `AS day`.
   Новые PGlite/native PostgreSQL тесты проверяют выполнение настоящего SQL,
   последние измерения по дням Москвы, разделение аккаунтов, `NULL` и bigint.
2. При первой ошибке API панель показывала агента как «Включён», очередь как
   нулевую и отсутствие неопределённых отправок. Теперь показывается отсутствие
   данных; Playwright воспроизводит HTTP 503 до исправления и проверяет результат.
3. После восстановления API метрик успешный polling оставлял старую ошибку.
   Успех теперь очищает ошибку. Playwright проверяет переход 503 → данные,
   графики и сохранение неизвестных метрик вместо фиктивного нуля.
4. Миграционный runner принимал журнал из следующей схемы `search_path`
   за журнал текущей схемы. Дефект проявился при повторном полном PostgreSQL
   прогоне после установки public-схемы приложения. Поиск журнала ограничен
   `current_schema()`; тест проверяет независимые public/isolated журналы.
   Native test проверяет отсутствие именно своего журнала, а не public fallback.

## Проверенное поведение

- Очередь: создание, manual-first, legacy/new дедупликация, запрет повторной
  отправки после send-boundary, queued/running/uncertain/published/failed,
  восстановление после аварии и сохранение уже опубликованных результатов.
- PostgreSQL: конкурентные enqueue/finalize, аренды, SKIP LOCKED, fencing,
  rollback связанных записей, потеря подтверждения COMMIT, миграции и replay.
- Circuit Breaker: пороги, open/half_open, одиночная проба, reset с подтверждением,
  истечение незавершённой пробы; независимость heartbeat от блокировки publisher.
- X-моки: точный автор, tweet ID, parent reply, неоднозначные результаты,
  наблюдение реакций, HTTP 401/403/429, запрет автоматического повтора uncertain.
- Шифрование: legacy AES-GCM ↔ V2 TS/CJS, неизвестный/отсутствующий ключ,
  изменение заголовка/шифротекста, тестовая ротация обеих таблиц и полный rollback,
  запрет ротации при свежем heartbeat и удерживаемой Worker advisory lock.
- Отдельная репетиция: полный pg_dump тестовой БД → V2 rotation → pg_restore
  во вторую `_test` БД → успешное чтение восстановленной legacy-сессии старым
  тестовым ключом. Реальных сессий и ключей в репетиции нет.
- Реальные локальные сервисы: Next API → IPC → PostgreSQL; запуск autopost Worker,
  heartbeat, forced termination и новый запуск с новым worker_id; dashboard;
  отклонение чужого Origin с HTTP 403. БД не содержит X-аккаунтов или заданий.
- Playwright: реальные страницы Settings/X Collector/Autopost, пять состояний
  очереди, журнал, все состояния Worker, open/half_open, статистика/графики,
  ошибки API и восстановление polling. Внешние запросы блокируются, mutations
  API запрещены тестом. Проверка повторена после перезапуска frontend.

## Повтор браузерной проверки

Установить зависимости `x-collector` и `solana-launcher`, запустить изолированный
frontend development server на `127.0.0.1:3310`, затем из `solana-launcher`:

```powershell
node tests/xcollector-local-smoke.mjs
```

URL можно передать через `X_COLLECTOR_SMOKE_URL` (разрешён только 127.0.0.1).
Скриншот сохраняется при заданном `X_COLLECTOR_SMOKE_SCREENSHOT`.
Браузерные API полностью мокируются; этот сценарий не является live X smoke.

## Граница приёмки

Live X: **NOT TESTED**, по прямому запрету пользователя. Production-ротация,
проверка реальных cookies, публикации/лайки/репосты/ответы/подписки и merge
не выполнялись. Для реального X smoke потребуется отдельное явное разрешение.
Успех offline-проверок не закрывает live gate плана V2-08.


## Итоговые результаты

| Проверка | Результат |
|---|---|
| npm run typecheck | PASS |
| npm run lint | PASS, 0 errors / 8 warnings |
| npm test | 367 passed / 0 failed / 0 skipped |
| npm run build | PASS |
| npm run test:db | 12 passed / 0 failed / 0 skipped, настоящий PostgreSQL 16 |
| npm run test:postgres | PASS, native worker/archive/leases + fixture benchmark |
| Frontend TypeScript | PASS |
| Frontend npm run lint | PASS, 0 errors / 367 warnings |
| Frontend npm run build | PASS, analysis regressions + production Next build |
| Playwright после исправлений и перезапуска | 11 passed / 0 failed |
| Локальные реальные сервисы после перезапуска | 8 проверок passed / 0 failed |
| Test-only PostgreSQL backup/rotation/restore | PASS |

После последнего исправления повторены все шесть команд collector. Все
падения, связанные с четырьмя перечисленными дефектами, устранены. Отдельные
ошибки настройки нового приёмочного сценария исправлены до итогового прогона.

Изменённые файлы:

- docs/CODEX_PROJECT_CONTEXT.md
- docs/CODEX_PROGRESS.md
- solana-launcher/app/settings/AutopostPanel.tsx
- solana-launcher/app/settings/PublisherMetrics.tsx
- solana-launcher/tests/xcollector-local-smoke.mjs
- x-collector/lib/trade/migration-integrity.ts
- x-collector/scripts/autopost/engine.cjs
- x-collector/tests/autopost-stats-fixture.ts
- x-collector/tests/autopost-stats.test.ts
- x-collector/tests/integration/autopost-stats.test.ts
- x-collector/tests/migration-integrity.test.ts
- x-collector/tests/integration/migration-integrity.test.ts
- x-collector/docs/AUTOPOST_IMPLEMENTATION_PLAN_V2_RU.md
- x-collector/docs/V2_08_LOCAL_ACCEPTANCE_20261019_RU.md
