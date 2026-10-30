# POTAPoff Control Center v1.0.3

Отдельный операционный Control Center с read-only доступом к продуктовым данным всего `claude-project`.

## Возможности

- PostgreSQL/SQLite Database Explorer: таблицы, колонки, строки, поиск, сортировка, пагинация и CSV export;
- объединённый список пользователей, регистраций и последних входов;
- Blockchain/Solana, Telegram и X/Twitter datasets;
- глобальный поиск и граф связей query → table → record;
- обзор queues / analysis runs;
- runtime monitoring и health источников;
- feature flags, alerts и audit trail;
- файловые логи;
- Solana account/transaction JSON-RPC lookup.

Продуктовые базы не изменяются: SQLite принудительно открывается в `mode=ro` + `PRAGMA query_only`, PostgreSQL — с `default_transaction_read_only=on` и `SET TRANSACTION READ ONLY`.

## Защита

- HMAC-сессия в `HttpOnly`, `SameSite=Strict` cookie;
- scrypt-хэш пароля;
- rate limit входа;
- production Origin allow-list (`ADMIN_ALLOWED_ORIGINS`);
- опциональный IP/CIDR allow-list;
- proxy headers учитываются только при `ADMIN_TRUST_PROXY=true`;
- маскирование паролей, токенов, seed/private-key и cookie полей, включая вложенный JSON;
- защита CSV от spreadsheet formula injection;
- контейнер non-root, `read_only`, `cap_drop: ALL`, без Docker socket;
- отдельная SQLite БД для audit/flags/alerts.

## Запуск

```bash
cd admin-site
cp .env.example .env
cp sources.example.json sources.json
cp logs.example.json logs.json

# Укажите реальный admin origin, например:
# ADMIN_ALLOWED_ORIGINS=https://admin.example.com

docker compose build
docker compose run --rm admin python scripts/hash_password.py
# вставьте результат в ADMIN_PASSWORD_HASH

docker network create potapoff-shared || true
docker compose up -d
```

Обновите DSN в `sources.json` под реальные read-only credentials и сетевые имена контейнеров.

## Проверки

Из корня монорепозитория:

```bash
bash admin-site/scripts/test-deep.sh
```

Набор включает auth/session, CSRF/origin, proxy/IP, read-only SQLite URI, pagination/search, failure paths, masking, CSV injection, alerts и Solana validation/RPC regression tests.

## Nginx и логи

Шаблон Nginx: `deploy/nginx-admin.conf`.

Control Center не получает `/var/run/docker.sock`. Application logs монтируются read-only. Профиль `host-logs` использует Fluent Bit только для чтения container log files.

## Вкладка X Collector

Отдельная вкладка показывает все таблицы, обычные и материализованные представления `public` выделенной базы коллектора. Доступны поиск по открытым полям, точный фильтр по столбцу, сортировка, страницы по 50 записей и карточки со всеми полями. Числа записей в результатах поиска точные; слишком тяжёлые запросы ограничены тайм-аутом 8 секунд.

В `admin-site/.env` задайте `ADMIN_X_COLLECTOR_DSN=postgresql://collector_admin:password@collector-postgres:5432/x_collector`, используя реальный адрес PostgreSQL, доступный из контейнера админки. Затем пересоберите и перезапустите admin. Не используйте DSN основной продуктовой базы. Подключение проверяет наличие таблиц `x_tasks` и `twitter_tweets`. Если DSN не задан, вкладка объясняет, что нужно настроить; остальные разделы работают как раньше.

Роль должна иметь SELECT для просмотра и INSERT/UPDATE/DELETE только на таблицах коллектора, USAGE на схеме и последовательностях. Представления и `schema_migrations` доступны только для чтения. Редактирование и удаление требуют полного первичного ключа и совпадения версии записи: при конкурентном обновлении возвращается конфликт, данные нужно перечитать. Секретные и бинарные поля скрыты и не редактируются через вкладку; настройка сессий остаётся в CLI коллектора. Запись остальных продуктовых баз по-прежнему запрещена.

Добавление, изменение и удаление требуют подтверждения в интерфейсе, используют существующую авторизацию, Origin/MFA/reauth защиту и журнал аудита. Удаление выполняется по правилам внешних ключей PostgreSQL, включая настроенные каскады. В карточке явно выбираются записываемые поля; NULL задаётся отдельной отметкой, неотмеченные поля не изменяются.

### Связь с основным сайтом

Control Center показывает таблицу назначения изменений и проверяет чтение
настроек подписки через API основного сайта и доступность базы X Collector.
Доступность чтения не гарантирует права записи: они проверяются при сохранении.
Настройки подписки сохраняет backend в своей транзакции; Mini App читает тот же
объект. X Collector сохраняет изменения в своей PostgreSQL; материализованные
сводки обновляются планировщиком. Источники общей вкладки «Базы данных» доступны
для чтения. Флаги Control Center и профили анализа сохраняются в хранилище
админки; основной backend их автоматически не применяет.

Для локального запуска укажите `POTAPOFF_BACKEND_URL` с адресом работающего
backend. Twitter monitoring использует этот адрес по умолчанию; отдельный
`ADMIN_TWITTER_BACKEND_URL` переопределяет его. Ключи подписки и Twitter должны
совпадать с соответствующими ключами backend. База коллектора задаётся отдельно
через `ADMIN_X_COLLECTOR_DSN`. Проверка не выводит адреса с паролями или ключи.


### TG Collector в Control Center

Вкладка TG Collector рядом с X Collector показывает реальные сообщения, источники,
состояние worker, счётчики и Start/Stop без перехода на другую страницу.
Админка обращается к существующему локальному Next API на `127.0.0.1:3100`
через серверный мост `/api/tg-collector`; коллектор и его сессия не дублируются.
Требуется обычная сессия администратора; для Start/Stop действует существующее
подтверждение опасных действий и обязательная проверка Origin.

Сервер использует `TG_COLLECTOR_ADMIN_TOKEN` из своего окружения либо существующего
`solana-launcher/.env.local` в этом checkout. Браузеру этот токен не передаётся.
Настройки аккаунта, сессии и прокси остаются у уже работающего коллектора.
Мост рассчитан на локальную установку с Next в режиме разработки; для отдельного
хоста или production требуется отдельная серверная интеграция.

Проверка моста: `python -m unittest discover -s tests -p test_tg_collector_admin.py`.

## Полные интерфейсы TG Invite, TG Collector и X Collector

Рабочие пространства находятся только в отдельной админке: `/collectors/tg-invite`, `/collectors/tg-collector`, `/collectors/x-collector`. Используются исходные React-компоненты и существующие API/хранилища; старые страницы основного сайта перенаправляют сюда через серверный `ADMIN_SITE_URL`, либо возвращают 404, если адрес не задан.

UI собирается из корня репозитория командой `node solana-launcher/node_modules/vite/bin/vite.js build --configLoader native --config admin-site/ui/vite.config.mjs`. Зависимости берутся из lockfile `solana-launcher` (`npm ci --legacy-peer-deps`). Dockerfile собирает UI отдельным этапом; его build context теперь корень репозитория, например `docker build -f admin-site/Dockerfile .`.

Админская HttpOnly-сессия защищает страницы и серверный мост. `ADMIN_TGINVITE_ACCESS_TOKEN` задаёт существующую identity/owner TG Invite только на сервере. Токен не отправляется браузеру. Существующие локальные API и backend должны работать в том же сетевом пространстве, что и админка: loopback контейнера не указывает на хост. Текущий production Compose сам такой operational runtime не создаёт. Полная проверка production-подключения остаётся отдельным шагом; см. `docs/architecture/ADMIN_WORKSPACE_MIGRATION_20261029.md` в корне репозитория.
PR #204 (2026-10-30): Settings now contains only Account, Quick Actions, Activity and Colors. Diagnostics, Apify and Blockchain join TG Invite/TG Collector/X Collector exclusively in the standalone admin-site under /collectors/{module}. Legacy settings query links redirect to the configured separate origin or return 404. Existing components/APIs are reused behind the admin session; the fixed API bridge preserves XLSX uploads (16 MiB), operator bearer identity, same-origin mutation checks and read-only diagnostic endpoints. Standalone RPC diagnostics use the server endpoint, not an external browser request. The running local site uses a different checkout; these PR changes do not update it. No merge, deployment or service restart.

When the Next checkout and the installed X Collector differ, set server-only `X_COLLECTOR_DIR` on the Next process to the existing collector root (scripts, migrations and node_modules). Keep `X_COLLECTOR_ENV` pointing to its existing configuration. Do not duplicate or reinstall an active collector just to satisfy an installation indicator. `ADMIN_COLLECTOR_ACCESS_TOKEN` / `ADMIN_TGINVITE_ACCESS_TOKEN` belong only to Python admin-site, never the product Next environment or browser.

PR #204 admin navigation correction (2026-10-30): all six operational tools now render inside the existing admin shell, with its sidebar retained. Navigation uses view buttons and same-origin embedded workspaces; the top-level pathname stays /, no new tab or different browser origin is opened. Former /collectors/{module} document links redirect to /#collector-{module}; authenticated embedded content remains guarded by require_admin. Only embedded workspaces permit same-origin framing; the admin shell remains frame-denied. Local admin binding and its existing supervisor/health probe now use 8888; the obsolete 18080 UI listener is closed. Existing backend API ports are server-internal and are not browser navigation targets. Live click tests cover all six views, one browser tab, no popups, same-origin navigation and login denial. No merge or server deployment.
