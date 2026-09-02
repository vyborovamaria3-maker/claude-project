import pytest
from pydantic import ValidationError

from app.core.config import Settings


SECRET = "a9f4c2e8d7b1f6a3c9e5d2b8f7a4c1e9d6b3f8a2c5e7d4b9a1f3c6e8d2b7a5c9"
BACKEND_API_KEY = "b" * 64
SUBSCRIPTION_INTERNAL_KEY = "s" * 64
SUBSCRIPTION_ADMIN_KEY = "a" * 64


def production_settings(**overrides):
    values = {
        "secret_key": SECRET,
        "environment": "production",
        "debug": False,
        "admin_password": "very-long-admin-password-2026",
        "admin_session_secret": "f" * 64,
        "backend_api_key": BACKEND_API_KEY,
        "subscription_internal_key": SUBSCRIPTION_INTERNAL_KEY,
        "subscription_admin_key": SUBSCRIPTION_ADMIN_KEY,
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


def test_api_service_requires_subscription_internal_key():
    with pytest.raises(ValidationError):
        production_settings(
            subscription_internal_key="",
            require_subscription_internal_key=True,
        )


def test_api_service_requires_subscription_admin_key():
    with pytest.raises(ValidationError):
        production_settings(
            subscription_admin_key="",
            require_subscription_admin_key=True,
        )


def test_worker_process_can_omit_subscription_keys():
    settings = production_settings(
        subscription_internal_key="",
        subscription_admin_key="",
    )
    assert settings.require_subscription_internal_key is False
    assert settings.require_subscription_admin_key is False
    assert settings.subscription_internal_key == ""
    assert settings.subscription_admin_key == ""


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("subscription_internal_key", BACKEND_API_KEY),
        ("subscription_admin_key", BACKEND_API_KEY),
        ("subscription_admin_key", SUBSCRIPTION_INTERNAL_KEY),
    ],
)
def test_production_requires_distinct_internal_keys(field, value):
    with pytest.raises(ValidationError):
        production_settings(**{field: value})


def test_production_rejects_wildcard_cors():
    with pytest.raises(ValidationError):
        production_settings(cors_origins=["*"])


def test_production_accepts_explicit_strong_security_settings():
    settings = production_settings(
        require_subscription_internal_key=True,
        require_subscription_admin_key=True,
    )
    assert settings.environment == "production"
    assert settings.debug is False
    assert settings.require_subscription_internal_key is True
    assert settings.require_subscription_admin_key is True
    assert len(
        {
            settings.backend_api_key,
            settings.subscription_internal_key,
            settings.subscription_admin_key,
        }
    ) == 3
