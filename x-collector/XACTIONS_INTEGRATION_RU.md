# XActions HTTP: экспериментальная локальная интеграция

Ветка: `feature/xactions-http-engine`, PR #61 (draft, **не объединять в main**).
Зафиксированный источник: `nirholas/XActions` v3.5.0, commit
`b9c4bf7bd680f82d4ede0a1b48bb1c5dbfd7bb78`.

## Статус

Реализован отдельный HTTP-путь для **profile**, **timeline**, **members** и обычных поисковых
заданий `list:<ID>` без параметров архивного/исторического сбора. Изменения
в рабочем сборщике активируются **только** через `COLLECTOR_ENGINE=xactions`.

По умолчанию весь сбор остаётся Playwright. Текстовый поиск, исторические
задания и сбор участников списков пока работают по старому пути либо ещё
не интегрированы. Режим `auto` пока не реализован.

## Новые модули

- `src/xactions/transport.ts`: SOCKS5 с жёсткой проверкой схемы прокси,
  отменой запроса, тайм-аутом, ограничением тела и отсутствием прямого fallback.
- `src/xactions/session.ts`: cookies из уже арендованной и расшифрованной
  Playwright-сессии; только домены X.
- `scripts/xactions-http-loader.cjs`: загрузка ESM библиотеки из локального
  checkout XActions с проверкой точного commit SHA.
- `src/xactions/runtime.ts`: отключены фоновое обновление query IDs,
  дополнительная подпись и автоматические повторы. Разрешены только HTTPS
  обращения к x.com, с прокси и единой отменой. Для новой библиотеки нужен
  Node.js >= 22.12; остальной сборщик сохраняет совместимость с Node 20.
- `src/xactions/engine.ts`: чтение профиля, авторской ленты, списка и страниц участников. Парсеры `userTimelineInstructions` и `parseUserList` загружаются из отдельных исходных модулей XActions.
- `src/xactions/normalize.ts`: приводит ответы к формату TweetSchema/ProfileSchema;
  отсутствие метрик, которое XActions иногда превращает в ноль, сохраняется
  консервативно как null (включая настоящий 0, если его нельзя отличить).
- `src/xactions/account-http-quota.ts`: первые HTTP запросы входят в уже
  списанный вес задания, дополнительные резервируют квоту в x_accounts под
  той же действующей арендой. При исчерпании задача откладывается.
- `migrations/042_xactions_list_members.sql`: отдельная таблица наблюдений участников списков и новый тип задач `members`.
- `src/xactions/persist-members.ts`: атомарная запись профилей, принадлежности к списку и HTTP-курсора.
- `migrations/041_xactions_checkpoints.sql` и `src/xactions/checkpoint-store.ts`:
  независимые HTTP cursors и lease fencing.
- `src/xactions/persist.ts`: публикации и курсор сохраняются в **одной**
  PostgreSQL-транзакции через существующий `persistTweets`. Числовые
  `history_max_id` и `list_max_id` не заменяются HTTP курсорами.
- `src/xactions/task.ts`: маршрутизация разрешённых задач через общий worker.
- `tests/xactions-http.test.ts`, `tests/xactions-engine.test.ts`,
  `tests/xactions-runtime.test.ts`: автономные проверки без обращения к X.

## Подготовка Windows для будущих ручных тестов

Не выполняйте эти команды на рабочей копии, пока PR не пройдёт все проверки,
и предварительно сделайте резервную копию БД.

В PowerShell установите Node.js 22.12+ и Git. Затем в отдельную директорию
клонируйте XActions и переключитесь на строго проверенный коммит:

```powershell
git clone https://github.com/nirholas/XActions.git C:\\tools\\XActions
cd C:\\tools\\XActions
git checkout b9c4bf7bd680f82d4ede0a1b48bb1c5dbfd7bb78
npm ci
```

В новом терминале для X Collector (после `npm ci`, настройки локального PostgreSQL,
наличия действующих аккаунтов SOCKS5 и запуска миграции 041) включите
экспериментальный режим:

```powershell
$env:XACTIONS_ROOT = "C:\\tools\\XActions"
$env:COLLECTOR_ENGINE = "xactions"
```

Без этих двух переменных запускается прежний Playwright-парсер. Если
используются только браузерные задачи, установка XActions не нужна.
Прокси и сессии берутся из `x_accounts`, пароли в окружение не копируются.
**Ветка пока экспериментальная, делать реальные запросы к X рано.**


Для постановки отдельного задания на участников списка (после применения
миграций, только в экспериментальном режиме):

```powershell
$env:COLLECTOR_ENGINE = "xactions"
npm run xactions:members -- 1878727153048777016 100
```

Это добавляет в **локальную PostgreSQL** задачу `members`; фактический сбор
происходит при запуске worker. Нельзя запускать на рабочей базе до
контролируемых интеграционных испытаний.

## Проверки

```powershell
cd x-collector
npm run typecheck
npm run lint
node --import tsx --test tests/xactions-http.test.ts tests/xactions-engine.test.ts tests/xactions-runtime.test.ts
npm run test
```

GitHub Actions выполняет проверку на Linux без реальных X-аккаунтов.
Локальный запуск на Windows, реальные HTTP вызовы через SOCKS5,
транзакционная проверка crash/restart и полнота данных требуют отдельного
контролируемого теста. Результат CI указан в PR, не в этом документе.

## Ограничения

- В `XActions` 3.5.0 нет гарантии стабильности приватных GraphQL endpoints.
- Не исправлен `SearchTimeline` HTTP 404; ключевые слова собираются Playwright.
- Участники списков поддержаны отдельным типом задач, но полнота списка и реальные HTTP-ответы ещё не проверены на Windows.
- При исчерпании лимита страниц курсор может оставаться незавершённым,
  хотя само задание уже помечено completed — это ожидаемо, но требует
  отдельной политики для дальнейшего архивного сбора.
- Переход XActions без ручной проверки не включать в production.
