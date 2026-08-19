from datetime import timedelta

from app.core.config import get_settings
from app.core.security import create_access_token, get_password_hash, verify_password


def test_password_hash_roundtrip():
    hashed = get_password_hash("password123")
    assert verify_password("password123", hashed)


def test_create_access_token():
    settings = get_settings()
    token = create_access_token(
        subject="123", settings=settings, expires_delta=timedelta(minutes=5)
    )
    assert token
