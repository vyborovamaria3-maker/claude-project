# ARCH-11 — Token Intelligence в существующем POTAPoff

Статус: **draft PR** на ветке `feat/arch-11-potapoff-token-intelligence-ui-20261020`, поверх ARCH-10 PR #143 → ARCH-09 и остальных черновиков. `main` не изменён. Никаких подключений к рабочим базам, X-сессиям, MTProto или платным Solana RPC при разработке не выполнялось.

## Где добавлено

| Компонент | Назначение |
| --- | --- |
| `solana-launcher/app/intelligence/token/page.tsx` | Новый экран в текущем Next.js/React POTAPoff, доступный из существующего `/intelligence` |
| `solana-launcher/app/api/intelligence/token/[mint]/[resource]/route.ts` | Встроенный серверный прокси Next.js, использующий `requireProdAuth()` — уже действующую проверку авторизации/подписки в production |
| `solana-launcher/lib/token-intelligence/proxy-core.mjs` | Изолированный серверный транспорт только к `127.0.0.1:<port>`, защита времени/адреса, лимиты и повторная фильтрация полей ответа |
| `intelligence/api/start.mjs` из ARCH-10 | Отдельный **локальный foreground** read-only API; POTAPoff не читает сырые БД X/TG/Blockchain |
| `solana-launcher/scripts/token-intelligence-proxy-regression.mjs` | Офлайн проверки приватности, SSRF, структуры данных, fail-closed режима |
| `.github/workflows/token-intelligence-potapoff.yml` | Короткая CI-проверка на PR без секретов и доступа к пользовательским базам |

Старые `/api/intelligence/*` и текущие X/TG/Blockchain Collector API **не заменяются** и не модифицируются. Новый маршрут `/api/intelligence/token/<mint>/timeline|links` — отдельная защищённая интеграция с Intelligence v1.

## Цепочка доступа

```text
Browser POTAPoff (/intelligence/token)
  -> NEXT GET /api/intelligence/token/:mint/timeline|links
  -> requireProdAuth(req) [existing production session/subscription check]
  -> per-IP in-process rate limit (20/min)
  -> validate exact canonical Solana mint and two UTC dates
  -> server-only Bearer from INTELLIGENCE_API_TOKEN
  -> HTTP 127.0.0.1:INTELLIGENCE_API_PORT [no arbitrary upstream URL]
  -> local Intelligence v1: existing queryTokenTimeline / queryActiveTokenLinks
  -> Intelligence PostgreSQL READ ONLY
  -> allowlisted projection back to browser
```

**Не раскрывать `INTELLIGENCE_API_TOKEN` в браузере**, клиентском JS, HTML, `NEXT_PUBLIC_*`, query params, логах или общедоступной документации. Серверная Next.js переменная `INTELLIGENCE_API_TOKEN` совпадает с токеном локального Intelligence API. Она НЕ имеет отношения к cookie пользователя и не подменяет проверку доступа POTAPoff. Никаких новых браузерных токенов не нужно.

## Запуск на том же ноутбуке Windows

Условия: локально работает **Intelligence v1** из ARCH-10, применены целевые PostgreSQL миграции 001, 002, 004, DB-роль имеет только SELECT; X/TG/Blockchain collectors независимо запускаются оператором, не этой интеграцией.

1. В директории `intelligence` вручную задать конфиденциальные `INTELLIGENCE_DATABASE_URL`, `INTELLIGENCE_API_TOKEN` (уникальный 32-128 base64url) и включить `INTELLIGENCE_API_ENABLED=true`. Запустить `npm run api:local`. Он слушает только `127.0.0.1`, порт 3182 по умолчанию.
2. В директории `solana-launcher` в **другом PowerShell окне на том же Windows-ноутбуке** задать **тот же** `INTELLIGENCE_API_TOKEN`, `POTAPOFF_TOKEN_INTELLIGENCE_ENABLED=true` и при необходимости `INTELLIGENCE_API_PORT=3182`.
3. После проверки миграций, доступа и резервных копий вручную запустить существующий Next.js (`npm run dev:local`). Открыть страницу `http://127.0.0.1:3000/intelligence/token`.
4. Указать **полный Solana mint (Base58)**, не тикер и не адрес кошелька. Указать две временные границы: «события до» и «известно на». В форме браузера времена вводятся как локальные; при отправке они преобразуются в UTC и проверяются на сервере.
5. Если выключен API, нет миграции/пользовательской подписки или неверен токен, интерфейс показывает **явную ошибку**, а не нулевую историю.

Пример только безопасной схемы включения (реальные токены вставлять в секретное окружение отдельно, не коммитить и не вставлять в публичный чат):

```powershell
# Terminal 1 (folder intelligence)
$env:INTELLIGENCE_API_ENABLED='true'
npm run api:local

# Terminal 2 (folder solana-launcher)
$env:POTAPOFF_TOKEN_INTELLIGENCE_ENABLED='true'
$env:INTELLIGENCE_API_PORT='3182'
npm run dev:local
```

**ВАЖНО ПРО DOCKER:** Внутри Next.js контейнера `127.0.0.1` — **сам контейнер**, а не Windows-ноутбук. Эта ветка не открывает API в сеть, не добавляет host.docker.internal, reverse proxy и не меняет Docker network. Таким образом, интеграция «Next в отдельном контейнере → локальный Intelligence на хосте» **не работает автоматически**; для production/docker требуется отдельный security-reviewed дизайн закрытого контейнерного канала/sidecar, а не смена адреса на публичный URL.

## Версия данных и ограничения

- В UI есть два независимых списка: **Timeline** и **действующие подтверждённые связи** X/TG; выдуманных связей и дедукции тикер→mint нет.
- Каждая строка содержит только стабильный ID доказательства, источник, тип (для Timeline), occurredAt, observedAt и краткий статус подтверждения. Исходные тексты X/TG, наименование пользовательского аккаунта, приватные payload и Solana provider details не пересылаются.
- Если вывод обрезан лимитом в 50 записей, UI показывает предупреждение. Пагинация сверх 50 требует нового API контракта; с текущим лимитом интерфейс не утверждает, что показал все.
- `historicalCompleteness="unknown"` всегда остаётся неизвестным. Нулевой результат не говорит об отсутствии сделок/публикаций, а наличие Mint-аккаунта не доказывает безопасность инвестиции.
- Изменения/удаления сообщений до включения ARCH-07a не могут быть восстановлены, если исходный журнал не хранит версии.
- Отдельный Dashboard из ARCH-09 измеряет очереди и сэмплы, но не гарантирует 100% истории; ARCH-11 не выдаёт эти счётчики за риск/доходность.

## Автотесты и условия допуска

- `npm run token-intelligence:test` — запускается на чистом Node 22, не делает RPC/SQL и не требует секретов.
- `npm run analysis:test` включает этот набор и существующие regressions POTAPoff.
- `.github/workflows/token-intelligence-potapoff.yml` выполняет короткий тест на GitHub-hosted runner; `Frontend Quality CI` выполняет отдельную полноценную сборку Next + UI smoke на установленном проектом runner.
- Проверяются неверное время/адрес, отключённая функция, порты/SSRF, отсутствие токена в клиенте, подмена данных upstream, утечка полей, ограничения размеров, заголовок server-only authorization и неизменность старых маршрутов.
- До merge обязательны review auth-границы `requireProdAuth`, статус CI на последнем HEAD, типизация Next/TypeScript и isolated manual smoke с парой процессов на одном ноутбуке. Не включать в production просто из-за зелёного CI.

Далее: полноценный многосетевой UI, контроль исторических gap-диапазонов, фильтрация по источнику и проектная схема безопасного server-to-server канала при Docker-развёртывании.
