from pathlib import Path

LAUNCHER_ROOT = Path(__file__).resolve().parents[2]


def _service_block(compose: str, service: str, next_service: str) -> str:
    start = f"\n  {service}:\n"
    end = f"\n  {next_service}:\n"
    return compose.split(start, 1)[1].split(end, 1)[0]


def test_frontend_receives_checkout_key_only():
    compose = (LAUNCHER_ROOT / "docker-compose.production.yml").read_text(encoding="utf-8")
    frontend = _service_block(compose, "frontend", "telegram-bot")

    assert "SUBSCRIPTION_INTERNAL_KEY" in frontend
    assert "SUBSCRIPTION_ADMIN_KEY" not in frontend
    assert "BACKEND_API_KEY" not in frontend
    assert "env_file:" not in frontend
    assert "POSTGRES_PASSWORD" not in frontend
    assert "RABBITMQ_PASSWORD" not in frontend
    assert "SECRET_KEY" not in frontend


def test_telegram_bot_does_not_inherit_backend_env_files():
    compose = (LAUNCHER_ROOT / "docker-compose.production.yml").read_text(encoding="utf-8")
    bot = _service_block(compose, "telegram-bot", "nginx")

    assert "env_file:" not in bot
    assert "BACKEND_API_KEY" not in bot
    assert "SUBSCRIPTION_INTERNAL_KEY" not in bot
    assert "SUBSCRIPTION_ADMIN_KEY" not in bot
    assert "POSTGRES_PASSWORD" not in bot
    assert "SECRET_KEY" not in bot
    assert "TELEGRAM_BOT_TOKEN" in bot
    assert "TELEGRAM_WEBHOOK_SECRET" in bot


def test_backend_api_requires_separate_subscription_keys():
    compose = (LAUNCHER_ROOT / "docker-compose.production.yml").read_text(encoding="utf-8")
    backend = _service_block(compose, "backend", "celery-worker")

    assert "SUBSCRIPTION_INTERNAL_KEY" in backend
    assert "SUBSCRIPTION_ADMIN_KEY" in backend
    assert 'REQUIRE_SUBSCRIPTION_INTERNAL_KEY: "true"' in backend
    assert 'REQUIRE_SUBSCRIPTION_ADMIN_KEY: "true"' in backend


def test_worker_does_not_receive_subscription_credentials():
    compose = (LAUNCHER_ROOT / "docker-compose.production.yml").read_text(encoding="utf-8")
    worker = _service_block(compose, "celery-worker", "telegram-intelligence")

    assert "SUBSCRIPTION_INTERNAL_KEY" not in worker
    assert "SUBSCRIPTION_ADMIN_KEY" not in worker


def test_production_database_runtime_uses_restricted_role_and_migrations_use_separate_role():
    compose = (LAUNCHER_ROOT / "docker-compose.production.yml").read_text(encoding="utf-8")
    deploy = (LAUNCHER_ROOT / "scripts" / "deploy-production.sh").read_text(encoding="utf-8")
    role_sql = (
        LAUNCHER_ROOT / "scripts" / "provision-postgres-roles.sql"
    ).read_text(encoding="utf-8")

    backend = _service_block(compose, "backend", "celery-worker")
    postgres = _service_block(compose, "postgres", "postgres-role-provisioner")
    assert "POSTGRES_APP_USER" in backend
    assert "POSTGRES_APP_PASSWORD" in backend
    assert "postgresql+asyncpg://potapoff:${POSTGRES_PASSWORD}" not in backend
    assert ".env.runtime" in backend
    assert ".env.server" not in backend
    assert ".env.server" not in postgres
    assert "postgres-role-provisioner" in backend
    assert 'DATABASE_URL="$MIGRATOR_DATABASE_URL"' in deploy
    assert "No blanket REASSIGN OWNED" in role_sql
    assert not __import__("re").search(r"^\\s*REASSIGN\\s+OWNED\\b", role_sql, __import__("re").MULTILINE)
    assert "NOBYPASSRLS NOINHERIT" in role_sql
    assert "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES" in role_sql
    assert "ALTER DEFAULT PRIVILEGES FOR ROLE" in role_sql
    assert "GRANT SELECT ON ALL TABLES IN SCHEMA public TO :" in role_sql
    assert "pg_read_all_data" not in role_sql


def test_production_redis_is_password_protected_and_isolated_from_public_frontend():
    compose = (LAUNCHER_ROOT / "docker-compose.production.yml").read_text(encoding="utf-8")
    redis = _service_block(compose, "redis", "rabbitmq")
    frontend = _service_block(compose, "frontend", "telegram-bot")
    backend = _service_block(compose, "backend", "celery-worker")

    assert "--requirepass" in redis
    assert "REDIS_PASSWORD" in redis
    assert "data-network" in redis
    assert "data-network" in backend
    assert "REDIS_PASSWORD" not in frontend
    assert "data-network" not in frontend


def test_backup_uses_separate_database_backup_login():
    backup = (LAUNCHER_ROOT / "scripts" / "backup-production.sh").read_text(encoding="utf-8")
    assert "POSTGRES_BACKUP_USER" in backup
    assert "POSTGRES_BACKUP_PASSWORD" in backup
    assert 'pg_dump -h 127.0.0.1 -U "$POSTGRES_BACKUP_USER"' in backup


def test_runtime_env_filter_removes_bootstrap_and_migration_secrets():
    deploy = (LAUNCHER_ROOT / "scripts" / "deploy-production.sh").read_text(encoding="utf-8")
    expected_env_filter = (
        "awk -F= '$1 !~ /^POSTGRES_/ && $1 != \"REDIS_PASSWORD\" { print }' "
        ".env.server"
    )
    expected_readonly_assignment = (
        'set_env_value "$ADMIN_ENV_FILE" POTAPOFF_DB_READONLY_PASSWORD '
        '"$POSTGRES_READONLY_PASSWORD"'
    )
    assert expected_env_filter in deploy
    assert expected_readonly_assignment in deploy


def test_admin_postgres_source_uses_read_only_role():
    sources = (LAUNCHER_ROOT.parent / "admin-site" / "sources.json").read_text(encoding="utf-8")
    assert "potapoff_readonly:${POTAPOFF_DB_READONLY_PASSWORD}" in sources
    assert "potapoff:${POTAPOFF_DB_PASSWORD}" not in sources
