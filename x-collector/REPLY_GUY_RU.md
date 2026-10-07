# AI Reply Guy в X Collector

Модуль добавляет кампании, персонажей, RAG, фильтры, черновики, официальный X API и Telegram. Он доступен по ссылке **Reply Guy** в существующем dashboard (`/reply`) и отдельным сервером на `http://127.0.0.1:3002/reply`. Старые восемь вкладок collector сохранены.

## Принятые решения по приложенному плану

| Раздел плана | Реализация |
| --- | --- |
| Аккаунты | OAuth 2.0 user access token; `GET /2/users/me` действительно проверяет доступ и username. Секреты не возвращаются в карточке |
| Cookies | Существующий collector сохраняет свой механизм сессий; Reply Guy публикует через официальный API. `auth_token` и `ct0` не подменяют OAuth |
| Email/lock | Доступ проверяется ответом API; статус верификации email не запрашивается и не выдумывается. 401 → needs_auth, 403 → blocked |
| Прокси | HTTP/HTTPS/SOCKS4/SOCKS5, четыре формата ввода, авторизация, таймаут 15 секунд, проверка ipify, шифрование, один endpoint на аккаунт. Прямой обход недоступного прокси отключён |
| Geo/timezone | Явная IANA timezone; при REPLY_PROXY_GEOLOCATION=true реальный lookup ipapi.co может установить timezone/страну. Если страна persona задана, непроверенная/другая страна прокси не позволяет старт кампании |
| Источники | Search и List ID, приоритет 1–10, максимум 5, пагинация и watermarks. Более высокий приоритет обрабатывается первым |
| Фильтры | Возраст, replies/retweets/quotes, likes/retweets/followers, слова и usernames. Слишком молодые посты остаются pending до min_age |
| Lore | CRUD, стиль/bio/system prompt/страна, 3–15 примеров для запуска. Embeddings и cosine top-3 RAG; данные и инструкции разделены |
| LLM/Vision | OpenAI или OpenAI-compatible endpoint, явные модели; картинки X передаются vision-модели. Нет текстовых заглушек при ошибке сервиса |
| Темп | Атомарная квота по часам, дневной лимит аккаунта, общий потолок 1000 попыток/UTC-день, задержка ≥15 секунд, sleep по timezone. Резервации переживают restart |
| Anti-detection | Слой маскировки, TLS/browser fingerprint spoofing и обход блокировок не добавлены; используется официальный API |
| Шифрование | Версионированный AES-256-GCM в архитектуре collector, вместо второго Fernet-формата. Keyring с key ID и транзакционная ротация |
| JWT | HS256, issuer/audience, срок, сохранённый jti и отзыв; все ресурсы ограничены user_id |
| Telegram | Private-chat allowlist, JWT к backend, команды кампаний/персонажей/источников/фильтров/черновиков/статистики, кнопки approve/reject, алерты после успешной доставки |
| Worker | Один fork-процесс на аккаунт, отдельные credentials/proxy, сессионный PostgreSQL advisory lock, остановка кампании при отказе авторизации |
| Публикация | POST /2/tweets, индивидуальная проверка или auto_publish для получателей с действующим согласием. Нет повтора POST при неопределённом результате |
| Деплой | Dockerfile и Compose с PostgreSQL/API/supervisor/Telegram. Очередь и блокировки остаются в PostgreSQL, Redis не требуется |

Актуальные правила X требуют предварительного письменного разрешения на AI reply bots и запрещают массовые нежелательные ответы. Поэтому отправка требует `REPLY_PUBLISH_ENABLED=true`, заполненного `REPLY_X_AI_APPROVAL_REF` и действующего записанного согласия получателя. Без этих условий доступны сбор данных, RAG и черновики. Это настройка доступа к внешней платформе, а не автоматическое получение разрешения.

Источник: https://help.x.com/en/rules-and-policies/x-automation
API: https://docs.x.com/x-api/posts/create-post
LLM: https://developers.openai.com/api/docs/guides/images-vision

## Локальный запуск

В папке `x-collector`:

```bash
npm ci
# Заполнить .env по .env.example; отдельная БД x_collector.
npm run migrate -- --status
npm run migrate
npm run reply:token -- TELEGRAM_USER_ID 24
npm run reply:api
# Отдельный терминал:
npm run reply:supervisor
# При настроенном боте, отдельный терминал:
npm run reply:telegram
```

Команда `reply:token` предназначена администратору и выводит секретный токен в терминал — не вставляйте его в публичные логи/issue. Сервис не имеет публичного endpoint выдачи токенов. Можно использовать существующий `npm run dashboard` вместо отдельного API; тогда backend URL бота должен вести на тот же server, с маршрутом `/api/reply`, либо запускайте отдельный API для бота. По умолчанию бот использует отдельный API на 3002.

Сначала через web-интерфейс подключите OAuth-аккаунт, создайте persona, добавьте минимум три пары примеров, создайте кампанию и источник. Для черновиков нужен supervisor. Кампания стартует с `auto_publish=false`. Ответы, которые старше текущего max_age, не отправляются даже после одобрения — при ручном review увеличьте max_age осознанно.

Ключевые переменные:

- `DATABASE_URL`: выделенная PostgreSQL БД.
- `MASTER_KEY`: постоянные 32 байта, hex или Base64; используется keyring по умолчанию.
- `JWT_SECRET`: случайный секрет ≥32 символов.
- `REPLY_PROXY_HASH_KEY`: отдельный постоянный секрет ≥32 символов; обязателен для назначения прокси, сохраняйте при остальных ротациях.
- `LLM_PROVIDER`: openai или compatible. `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_EMBEDDING_MODEL`. Локальный compatible endpoint допускается на loopback HTTP.
- `TELEGRAM_BOT_TOKEN`, `REPLY_TELEGRAM_ALLOWED_IDS`: числовые Telegram IDs через запятую. Бот не принимает команды в группах и от чужих пользователей.
- `REPLY_API_URL`: loopback HTTP или HTTPS. `REPLY_PUBLIC_URL`: защищённый адрес web-интерфейса для пользователя.

X token должен принадлежать пользователю и иметь разрешения для соответствующих операций: tweet.read/users.read, list.read для Lists, tweet.write для отправки. Возможности/платные лимиты определяются доступом вашего X-приложения. Автоматический OAuth refresh не реализован: просроченный token обновляется через PATCH аккаунта или web-форму. Refresh token шифруется, но не используется для скрытого восстановления заблокированного доступа.

## Telegram

После настройки allowlist отправьте `/connect`, затем `/help`.

- `/accounts`, `/campaigns`, `/lore`, `/drafts`, `/stats`, `/alerts`.
- `/start_campaign ID`, `/stop_campaign ID`, `/pause ID`, `/resume ID`.
- `/approve ID`, `/reject ID`, `/delete_account ID`.
- `/add_lore JSON`, `/example LORE_ID JSON`, `/source CAMPAIGN_ID JSON`.
- `/filters CAMPAIGN_ID JSON`, `/settings CAMPAIGN_ID JSON`, `/consent JSON`.
- `/revoke` отзывает JWT бота; `/connect` создаёт новый токен по явной команде пользователя.

OAuth-токены и прокси вводятся через защищённую web-форму, а не через Telegram. Удаление аккаунта каскадно удаляет его live credentials, кампанию, черновики, квоты и алерты; копии в резервных копиях регулируются вашей политикой backup.

Прокси проверяется при добавлении и каждые пять минут активной работы. Недоступный прокси ставит аккаунт на паузу и останавливает кампанию. После замены проверьте/возобновите аккаунт и стартуйте кампанию явно. Бот доставляет алерты только allowlisted пользователям, помечает delivered после успеха; при сбое сохраняет их для повторной попытки. Возможна обычная at-least-once повторная доставка алерта при падении после send.

## Ротация ключей

Укажите старый и новый ключ в `REPLY_ENCRYPTION_KEYS`, новый ID в `REPLY_ACTIVE_KEY_ID`. Обновите конфигурацию всех процессов, остановите supervisor и выполните:

```bash
npm run reply:rotate-key
```

Одна транзакция перешифровывает credentials и proxy; ошибка откатывает всё. Старый ключ удаляйте из keyring только после успешной ротации и перезапуска всех процессов. MASTER_KEY существующего collector не менять этим способом: legacy X browser sessions используют отдельный старый формат. `REPLY_PROXY_HASH_KEY` остаётся постоянным. Смена embedding model требует заново добавить/векторизовать примеры: модели разных embeddings не смешиваются.

## Docker

```bash
# Сначала .env, включая URL-safe REPLY_DB_PASSWORD, MASTER_KEY и JWT_SECRET.
docker compose -f compose.reply.yml build
docker compose -f compose.reply.yml --profile setup run --rm migrate
docker compose -f compose.reply.yml up -d api supervisor
docker compose -f compose.reply.yml run --rm api node dist/scripts/reply/token.js TELEGRAM_USER_ID
docker compose -f compose.reply.yml --profile telegram up -d telegram
```

Compose создаёт отдельный PostgreSQL volume, API публикуется только на loopback. Для внешнего доступа используйте TLS reverse proxy. `telegram` использует network namespace API, поэтому JWT не уходит через публичный HTTP. Миграции не запускаются автоматически при старте production workers. Docker-сборка в текущей среде не выполнялась: Docker отсутствует.

## API

Отдельный server: `/api/...`; встроенный dashboard: `/api/reply/...`. Заголовок `X-Reply-Token: JWT` (позволяет сохранить Basic Auth dashboard), также поддержан `Authorization: Bearer JWT` на отдельном API.

Реализованы endpoint-группы плана: accounts CRUD, proxy set/test/status, lore create/list/patch/examples, campaigns create/list/patch/start/stop, sources add/delete, filters patch, campaign/account stats, alerts. Дополнительно: blacklists, consents, drafts approve/reject/regenerate/reconcile и token revoke.

`uncertain` означает, что POST мог успеть выполниться. Он никогда не переводится обратно в отправку автоматически. Найдите ответ в X и передайте его ID в reconcile: API проверяет автора, текст и исходный post ID перед сменой статуса.

## Проверки и границы

```bash
npm run typecheck
npm run lint
npm test
npm run build
# Только отдельная БД с именем *_test:
REPLY_TEST_DATABASE_URL=postgresql://.../x_collector_test npm run test:postgres
```

Проверено: локально typecheck, lint, build и 51 тест; в GitHub Actions дополнительно успешно прошёл test:postgres на PostgreSQL 16 (run 37699216710).

Native integration создаёт уникальную тестовую схему и удаляет только её. Проверяет все миграции, конкурентный SKIP LOCKED и account leases. Не указывайте production БД.

Unit/PGlite/browser suite проверяет фильтры, sleep, прокси-парсер, шифрование/ротацию, X payload/pagination/error handling, tenant ownership, JWT revoke, RAG/vision payload, rate budget, неопределённую публикацию и интерфейс. X/LLM ответы в тестах контролируются fixtures; production код вызывает реальные сервисы и не подставляет тестовые результаты.

Не проверены живые X/LLM/Telegram/proxy endpoints, массовая нагрузка 10+ аккаунтов и производительность на 1000 ответов/день. Число — ограничение попыток, не обещание достижимого темпа. Нужны реальные доступы, модели, политика X и нагрузочная проверка.

X API: по умолчанию используются текущие `post.fields`/`referenced_posts`; `REPLY_X_FIELD_DIALECT=tweets` включает прежние имена параметров. Оба формата ответа нормализуются. List не получает `since_id`: watermark применяется локально и останавливает чтение старых страниц. Живой доступ вашего приложения необходимо проверить перед запуском публикации.

## Оптимизация генерации и тест нагрузки

Перед embeddings/chat запросами worker проверяет активность кампании, sleep/cooldown, оставшиеся часовые/дневные/общие квоты и пригодные review/approved/publishing черновики. В очереди поддерживается максимум три пригодных готовых черновика, а при меньшей квоте — меньше. Пост, который истечёт раньше ближайшего свободного слота отправки, не генерируется. Это предварительное ограничение затрат, а не замена атомарной резервации публикации; глобальная квота генерации между процессами не резервируется.

Страница источника записывается одним INSERT SELECT из JSONB вместо отдельного INSERT на каждый пост. Сохраняются транзакция, исключение собственных постов и ON CONFLICT дедупликация.

Контролируемая проверка: 10 аккаунтов, 500 кандидатов, квота два ответа в час; первый параллельный цикл создаёт 20 черновиков (40 запросов embeddings/chat), второй — ноль дополнительных LLM запросов. Исчерпанная квота тоже блокирует генерацию. Это тест production pipeline на PGlite с fixtures, не benchmark живых сервисов и не проверка десяти OS-процессов. Время выполнения не экстраполируется на production.
