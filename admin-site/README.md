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
