import hashlib
import hmac
import json
import time
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

import pytest
from sqlalchemy import select

from app.models.user import User


def signed_telegram_init_data(bot_token: str, user: dict) -> str:
    payload = {
        "auth_date": str(int(time.time())),
        "query_id": "test-query",
        "user": json.dumps(user, separators=(",", ":")),
    }
    data_check_string = "\n".join(
        f"{key}={value}" for key, value in sorted(payload.items())
    )
    secret = hmac.new(
        b"WebAppData",
        bot_token.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    payload["hash"] = hmac.new(
        secret,
        data_check_string.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return urlencode(payload)


@pytest.mark.asyncio
async def test_register_requires_subscription_before_login(client, test_app):
    payload = {
        "email": "user@example.com",
        "full_name": "Test User",
        "password": "supersecret123",
    }
    register_response = await client.post("/api/v1/auth/register", json=payload)
    assert register_response.status_code == 201
    assert register_response.json()["email"] == payload["email"]

    blocked = await client.post(
        "/api/v1/auth/login-json",
        json={"email": payload["email"], "password": payload["password"]},
    )
    assert blocked.status_code == 403
    assert blocked.json()["detail"] == "Active subscription required"

    async with test_app.state.sessionmaker() as session:
        result = await session.execute(
            select(User).where(User.email == payload["email"])
        )
        user = result.scalar_one()
        user.subscription_expires_at = datetime.now(UTC) + timedelta(days=7)
        await session.commit()

    login_response = await client.post(
        "/api/v1/auth/login-json",
        json={"email": payload["email"], "password": payload["password"]},
    )
    assert login_response.status_code == 200
    token = login_response.json()["access_token"]

    me_response = await client.get(
        "/api/v1/users/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert me_response.status_code == 200
    assert me_response.json()["email"] == payload["email"]


@pytest.mark.asyncio
async def test_removed_phantom_nonce_endpoint_is_not_available(client):
    response = await client.post(
        "/api/v1/auth/phantom/nonce",
        json={"wallet_address": "11111111111111111111111111111111"},
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_telegram_callback_rejects_unsigned_identity(client):
    response = await client.post(
        "/api/v1/auth/telegram/callback",
        json={"telegram_id": 42, "username": "attacker"},
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_telegram_callback_requires_signed_init_data(client):
    response = await client.post(
        "/api/v1/auth/telegram/callback",
        json={
            "init_data": "user=%7B%22id%22%3A42%7D&auth_date=1&hash=bad"
        },
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_telegram_callback_accepts_signed_init_data_for_subscriber(
    client,
    test_app,
):
    test_app.state.settings.telegram_bot_token = "123456:test-token"

    async with test_app.state.sessionmaker() as session:
        user = User(
            telegram_id="42",
            access_login="ada_access",
            subscription_expires_at=datetime.now(UTC) + timedelta(days=7),
            is_active=True,
        )
        session.add(user)
        await session.commit()

    init_data = signed_telegram_init_data(
        test_app.state.settings.telegram_bot_token,
        {
            "id": 42,
            "username": "ada",
            "first_name": "Ada",
            "language_code": "en",
            "is_premium": True,
        },
    )

    response = await client.post(
        "/api/v1/auth/telegram/callback",
        json={"init_data": init_data},
    )

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["access_token"]
    assert data["redirect_url"] == test_app.state.settings.frontend_url
    assert "token=" not in data["redirect_url"]

    async with test_app.state.sessionmaker() as session:
        result = await session.execute(
            select(User).where(User.telegram_id == "42")
        )
        user = result.scalar_one()
        assert user.telegram_username == "ada"
        assert user.first_name == "Ada"
        assert user.telegram_language_code == "en"
        assert user.telegram_is_premium is True
