# Intelligence API — ARCH-10 read-only v1

**Статус:** отдельный черновой PR поверх #141 и предыдущей архитектурной цепочки. Это **локальный API для серверного прокси**, не публичный браузерный API, не новый Collector и не автоматически включённый сервис. Никакие X/TG/Blockchain базы или аккаунты при разработке не открывались.

## Принципы безопасности

- Слушает **только 127.0.0.1**, фиксированное bind-правило. Сетевой доступ извне не включён даже при наличии публичного IP компьютера.
- Выключен по умолчанию: требует `INTELLIGENCE_API_ENABLED=true`. Отдельный длинный серверный токен `INTELLIGENCE_API_TOKEN` (32–128 base64url-символов); `Authorization: Bearer ...` проверяется по SHA-256 в постоянное по длине время. Ни cookie-сессии, ни токена в URL, ни browser localStorage.
- Токен — **строго server-to-server**. Нельзя вставлять его в код React, клиентский JavaScript, .env frontend, открытый API маршрутизатор или обращаться к нему напрямую из браузера. В будущем защищённый POTAPoff backend должен проверять авторизацию пользователя самостоятельно и проксировать запрос к loopback API с закрытым токеном.
- Нет CORS и поддержки OPTIONS/POST. Возвращаются `Cache-Control: no-store`, `nosniff`, запрет embedding и `Referrer-Policy: no-referrer`.
- Ограничены 60 запросов в минуту на процесс, 8 параллельных, 10 секунд на запрос и 5 секунд серверного PostgreSQL statement timeout.
- Доступ только к **отдельной базе Intelligence**, через `INTELLIGENCE_DATABASE_URL`. В рабочем окружении DB-роль должна иметь только `SELECT` на нужные представления/таблицы, **не** доступ к источникам. В соединении включён `default_transaction_read_only=on`.
- До запуска требуется таблица `token_link_observations` (миграции Intelligence **001, 002, 004**), иначе запуск отклоняется. Отсутствие источника, базы или таблицы не превращается в пустой успешный ответ.
- Ошибки запроса/базы обезличены: ни SQL, ни DSN, ни сообщение Twitter/Telegram, ни тело сырой транзакции, ни RPC provider response не возвращаются и не печатаются.
- Все запросы используют канонический `solana:<full-mint>` и строгие UTC-временные границы. SQL использует параметризацию существующего Intel слоя.

## Версионированные эндпоинты

| Method | Endpoint | Что возвращает |
| --- | --- | --- |
| GET | `/api/intelligence/v1/health` | **Авторизованное** подтверждение доступности только целевой PostgreSQL; не делает вид, что проверены X/TG/Blockchain |
| GET | `/api/intelligence/v1/tokens/:id/timeline` | Исторические evidence-backed события токена из существующего Timeline; только источник, тип, evidenceId и временные метки |
| GET | `/api/intelligence/v1/tokens/:id/links` | Действующие **как известно на момент knownAt** подтверждённые SPL-mint привязки X/TG с учётом edit/delete tombstones |
| GET | `/api/intelligence/v1/tokens/:id/evidence` | Два **раздельных** read-only списка: `socialLinks` (TG/X, с отзывом связей) и `blockchainSwapEvidence` (поддержанные ревизии swap-доказательств); это не финализированные сделки и не PnL |

Для `timeline`, `links`, `swap-evidence` и `evidence` обязательны query params `occurredBefore` и `knownAt` в **полном UTC ISO8601** (например `2026-10-20T02:00:00.000Z`). `knownAt` не может быть позже настоящего времени, `occurredBefore <= knownAt`; `limit` необязателен, 1–100, default 50. Дубликаты/неизвестные параметры, query-string токены, неполные ID и некорректные даты отклоняются.

Успешный ответ — `schemaVersion: token-intelligence-v1`, `tokenId`, фильтры времени, `items`, `truncated`, `historicalCompleteness: unknown`. Ответ **не включает** сырой `timeline.payload`, `token_link_observations.details`, `eventKey`, хеш исходного текста, приватные данные провайдера, первоначальный твит/сообщение. `truncated=true` означает, что выбранный лимит отрезал результат; **отсутствие truncated не означает полноту истории**. Версия v1 намеренно не заявляет активный risk score, PnL, 100% покрытие источников, finality блокчейна, непрерывность X/TG и верификацию личности.

Маршрут `evidence` использует общие `occurredBefore`/`knownAt` и отдельный лимит `limit` для каждой из двух категорий, возвращает `socialLinksTruncated` и `blockchainSwapEvidenceTruncated`. Содержимое `socialLinks` не подтверждает торговые результаты; `blockchainSwapEvidence` не является social-упоминанием или доказательством окончательной финализации. `historicalCompleteness` остаётся `unknown`. Пустые списки могут означать отсутствие доступных подтверждённых данных, а не отсутствие событий в реальности.

Нельзя принимать `queryTokenTimeline` как замену `queryActiveTokenLinks`: первый содержит события, второй — историческую текущую привязку с отзыванными версиями. `links` может быть неполным для редакций до включения source tombstone producer.

## Локальный запуск Windows PowerShell

Из папки `intelligence`. После проверки резервных копий/миграций **отдельной** Intelligence PostgreSQL, с секретами в защищённом локальном окружении:

```powershell
# Сгенерировать уникальный секрет в PowerShell (не коммитить!)
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"

# Сохранить сгенерированное значение локально как INTELLIGENCE_API_TOKEN
# Настроить INTELLIGENCE_DATABASE_URL на роль только с SELECT правами.
$env:INTELLIGENCE_API_ENABLED = 'true'
$env:INTELLIGENCE_API_PORT = '3182'
npm run api:local
```

В команду не вставляйте реальные пароли или токены. Переменные `INTELLIGENCE_API_TOKEN` и `INTELLIGENCE_DATABASE_URL` должны быть установлены отдельно и **не** попадать в историю shell, логи или скриншоты.

Для server-side smoke-test `GET /api/intelligence/v1/health` передайте заголовок `Authorization: Bearer <secret>` только из доверенного backend, а не из браузера.

Сервис запущен foreground на ноутбуке, закрывается Ctrl+C/SIGTERM. Не создаёт Windows-службу, Docker, сервер в облаке, SSH туннель, публичный URL, CORS или графический интерфейс. Live deployment и внешняя авторизация POTAPoff **ещё не выполнены**.

## Проверки перед merge

- Offline HTTP unit: правильный/неверный/дублированный Bearer, отказ без флагов, запрет OPTIONS и cookie fallback, неверные canonical IDs, query injection/duplicate params, UTC as-of, ограничение запросов, редактирование приватного payload и обезличивание ошибок.
- Отдельная PostgreSQL 16 схема: миграции 001/002/004, реальные записи Timeline и verified→invalidated, контроль отсутствия lookahead и исчезновения отозванной связи.
- CI `Intelligence foundation`, `Intelligence CI`, `Repository hygiene` должны быть зелёными **на последнем коммите**.
- Не включать на реальном ноутбуке без ревью прав DB-роли, сетевого bind, параметров маршрута, backup/restore и контроля токенов.

Следующий отдельный этап: ARCH-11 — авторизованный backend proxy POTAPoff + UI, использующий только этот read-only API, не соединяющий браузер с источниками и не раскрывающий серверный токен.


## ARCH-AI-01 — отделённый read-only контракт для внешнего ИИ

Это расширение зависит от Sprint 1 / PR #165. Без явного разрешения отдельные
AI-маршруты **отключены**. Подробная схема собственности всех баз данных,
ограничения покрытия и план подключения:
[AI_DATA_ACCESS_ARCHITECTURE.md](../../docs/architecture/AI_DATA_ACCESS_ARCHITECTURE.md).

Новые маршруты:

| Method | Endpoint | Значение |
| --- | --- | --- |
| GET | `/api/intelligence/v1/ai/catalog` | Декларативный каталог подключённых категорий и явно исключённых баз; **не** проверка живого состояния источников |
| GET | `/api/intelligence/v1/tokens/:id/ai-context` | Ограниченные анонимизированные счётчики TG/X, Blockchain, legacy Timeline и проверенный по двум временным границам feature snapshot |

**Изоляция токенов:** дополнительные переменные `INTELLIGENCE_AI_API_ENABLED=true`
и `INTELLIGENCE_AI_API_TOKEN=<другой длинный секрет>` обязательны для AI
маршрутов. Базовые `INTELLIGENCE_API_ENABLED=true`,
`INTELLIGENCE_API_TOKEN` и `INTELLIGENCE_DATABASE_URL` остаются
обязательными для запуска сервера. Обычный Bearer не получает AI-данные;
AI Bearer не имеет доступа к остальным маршрутам. Секрет не отправляется
напрямую сторонней модели: он хранится на авторизованном сервере-шлюзе,
который забирает JSON с loopback API и передаёт модели только очищенный
контекст. Шлюз должен отдельно проверять права конечного пользователя.

`ai-context` требует `occurredBefore` и `knownAt`; `limit` — от 1
до 100, с фактической верхней границей **50 на категорию**. Эти числа —
**размеры наблюдаемой выборки, не полные счётчики истории**. Каждый тип
снабжён своим флагом `truncated`. По умолчанию передаются только
агрегаты и проверенные типизированные метрики, без исходных текстов,
идентификаторов сообщений, адресов кошельков или свободных текстовых
меток охвата, которые модель могла бы ошибочно воспринять как команды.

Для AI дополнительно требуется миграция **003** (`chain_token_features`
и `feature_versions`) в изолированной Intelligence PostgreSQL,
проверяемая при запуске. Пока AI выключен, существующие API-эндпоинты
не обязаны иметь таблицы 003. Исторические feature snapshots фильтруются
по `as_of <= occurredBefore`, `max_input_observed_at <= knownAt` и
`computed_at <= knownAt` в одной read-only repeatable-read транзакции.

**Серверный AI gateway реализован отдельно:** `POST
/api/ai/v1/analyze-token` на `127.0.0.1:3183`, с четвёртым
`AI_GATEWAY_CLIENT_TOKEN` для вызывающего доверенного backend, явными
`AI_GATEWAY_ENABLED=true` и `AI_GATEWAY_EGRESS_ENABLED=true`
для разрешения внешнего запроса. Код провайдерского адаптера ограничен
фиксированным HTTPS endpoint и `store:false`; **реальная модель не
подключалась, платные запросы не выполнялись**. Полный интерфейс,
конфигурация, ограничения безопасности и релизные блокеры —
[ai-gateway/README.md](../ai-gateway/README.md).

**Не подключено к данным ИИ:** Python Intelligence documents,
Memecoin Intelligence, admin/подписки, raw source DBs, аккаунты и сессии.
Это требует самостоятельной политики доступа и отдельного релизного gate.
`historicalCompleteness=unknown` и `sourceCollectorLiveness=not_checked`
не означают отсутствие активности в источниках.
