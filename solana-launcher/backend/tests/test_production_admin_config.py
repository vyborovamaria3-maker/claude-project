import pytest
from app.core.config import Settings
from pydantic import ValidationError

SECRET = "a9f4c2e8d7b1f6a3c9e5d2b8f7a4c1e9d6b3f8a2c5e7d4b9a1f3c6e8d2b7a5c9"
BACKEND_API_KEY = "b" * 64


def production_settings(**overrides):
    values = {
        "secret_key": SECRET,
        "environment": "production",
        "debug": False,
        "admin_password": "very-long-admin-password-2026",
        "admin_session_secret": "f" * 64,
        "backend_api_key": BACKEND_API_KEY,
    }
    values.update(overrides)
    return Settings(**values)


def test_production_rejects_default_admin_credentials():
    with pytest.raises(ValidationError):
        Settings(secret_key=SECRET, environment="production")


def test_production_rejects_debug_mode():
    with pytest.raises(ValidationError):
        production_settings(debug=True)


def test_production_requires_internal_backend_api_key():
    with pytest.raises(ValidationError):
        production_settings(backend_api_key="")


def test_production_rejects_wildcard_cors():
    with pytest.raises(ValidationError):
        production_settings(cors_origins=["*"])


def test_production_accepts_explicit_strong_security_settings():
    settings = production_settings()
    assert settings.environment == "production"
    assert settings.debug is False


def test_blank_telegram_api_id_disables_telegram_intelligence():
    settings = production_settings(telegram_api_id="")
    assert settings.telegram_api_id is None
