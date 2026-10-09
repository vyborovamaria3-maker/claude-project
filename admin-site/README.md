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
