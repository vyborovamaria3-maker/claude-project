import pytest
from pydantic import ValidationError

from app.core.config import Settings


SECRET = "a9f4c2e8d7b1f6a3c9e5d2b8f7a4c1e9d6b3f8a2c5e7d4b9a1f3c6e8d2b7a5c9"


def test_nonproduction_defaults_do_not_embed_service_or_admin_credentials():
    settings = Settings(secret_key=SECRET, environment="test")

    assert settings.database_url.startswith("sqlite+")
    assert "potapoff:potapoff" not in settings.database_url
    assert "guest:guest" not in settings.celery_broker_url
    assert settings.admin_password == ""
    assert settings.admin_session_secret == SECRET


def test_production_requires_distinct_session_and_jwt_signing_secrets():
    with pytest.raises(ValidationError, match="ADMIN_SESSION_SECRET must be different"):
        Settings(
            secret_key=SECRET,
            environment="production",
            debug=False,
            admin_password="very-long-admin-password-2026",
            admin_session_secret=SECRET,
            backend_api_key="b" * 64,
            subscription_password_encryption_key="e" * 64,
        )
