import pytest
from pydantic import ValidationError

from app.core.config import Settings


SECRET = "a9f4c2e8d7b1f6a3c9e5d2b8f7a4c1e9d6b3f8a2c5e7d4b9a1f3c6e8d2b7a5c9"


def test_production_rejects_default_admin_credentials():
    with pytest.raises(ValidationError):
        Settings(secret_key=SECRET, environment="production")


def test_production_accepts_explicit_strong_admin_credentials():
    settings = Settings(
        secret_key=SECRET,
        environment="production",
        admin_password="very-long-admin-password-2026",
        admin_session_secret="f" * 64,
    )
    assert settings.environment == "production"
