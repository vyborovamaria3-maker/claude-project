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


def test_backend_api_requires_separate_admin_key():
    compose = (LAUNCHER_ROOT / "docker-compose.production.yml").read_text(encoding="utf-8")
    backend = _service_block(compose, "backend", "celery-worker")

    assert "SUBSCRIPTION_INTERNAL_KEY" in backend
    assert "SUBSCRIPTION_ADMIN_KEY" in backend
    assert 'REQUIRE_SUBSCRIPTION_ADMIN_KEY: "true"' in backend
