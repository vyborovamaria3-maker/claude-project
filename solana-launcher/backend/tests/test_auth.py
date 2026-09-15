import hashlib
import hmac
import json
import time
from urllib.parse import urlencode, urlsplit

import base58
import pytest
from app.models.user import User
from nacl.signing import SigningKey
from sqlalchemy import select


def signed_telegram_init_data(bot_token: str, user: dict) -> str:
    payload = {
        "auth_date": str(int(time.time())),
        "query_id": "test-query",
        "user": json.dumps(user, separators=(",", ":")),
    }
    data_check_string = "\n".join(f"{key}={value}" for key, value in sorted(payload.items()))
    secret = hmac.new(b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256).digest()
    payload["hash"] = hmac.new(
        secret, data_check_string.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return urlencode(payload)


@pytest.mark.asyncio
async def test_register_login_and_me(client, test_app):
    payload = {
        "email": "user@example.com",
        "full_name": "Test User",
        "password": "supersecret123",
    }
    register_response = await client.post("/api/v1/auth/register", json=payload)
    assert register_response.status_code == 201
    assert register_response.json()["email"] == payload["email"]

    login_response = await client.post(
        "/api/v1/auth/login-json",
        json={"email": payload["email"], "password": payload["password"]},
    )
    assert login_response.status_code == 200
    token = login_response.json()["access_token"]

    me_response = await client.get("/api/v1/users/me", headers={"Authorization": f"Bearer {token}"})
    assert me_response.status_code == 200
    assert me_response.json()["email"] == payload["email"]


@pytest.mark.asyncio
async def test_phantom_nonce_creates_wallet_user(client, test_app):
    wallet_address = "11111111111111111111111111111111"

    response = await client.post(
        "/api/v1/auth/phantom/nonce", json={"wallet_address": wallet_address}
    )
    assert response.status_code == 200

    body = response.json()
    assert body["nonce"] >= 10_000_000
    assert body["message"]
    assert body["expires_at"]

    async with test_app.state.sessionmaker() as session:
        result = await session.execute(select(User).where(User.wallet_address == wallet_address))
        user = result.scalar_one_or_none()

    assert user is not None
    assert user.nonce == body["nonce"]


@pytest.mark.asyncio
async def test_phantom_signature_is_valid_once(client):
    signing_key = SigningKey(b"\x01" * 32)
    wallet_address = base58.b58encode(bytes(signing_key.verify_key)).decode("ascii")
    nonce_response = await client.post(
        "/api/v1/auth/phantom/nonce",
        json={"wallet_address": wallet_address},
    )
    assert nonce_response.status_code == 200
    nonce_body = nonce_response.json()
    signature = base58.b58encode(
        signing_key.sign(nonce_body["message"].encode("utf-8")).signature
    ).decode("ascii")
    payload = {
        "wallet_address": wallet_address,
        "nonce": nonce_body["nonce"],
        "signature": signature,
    }

    verified = await client.post("/api/v1/auth/phantom/verify", json=payload)
    assert verified.status_code == 200
    assert verified.json()["access_token"]

    replay = await client.post("/api/v1/auth/phantom/verify", json=payload)
    assert replay.status_code == 401
    assert replay.json()["detail"] == "Invalid credentials"


@pytest.mark.asyncio
async def test_telegram_callback_rejects_unsigned_identity(client):
    response = await client.post(
        "/api/v1/auth/telegram/callback",
        json={"telegram_id": 42, "username": "attacker"},
    )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_telegram_callback_requires_signed_init_data(client, test_app):
    response = await client.post(
        "/api/v1/auth/telegram/callback",
        json={"init_data": "user=%7B%22id%22%3A42%7D&auth_date=1&hash=bad"},
    )

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_telegram_callback_accepts_signed_init_data_without_tokenized_redirect(
    client, test_app
):
    test_app.state.settings.telegram_bot_token = "123456:test-token"
    init_data = signed_telegram_init_data(
        test_app.state.settings.telegram_bot_token,
        {"id": 42, "username": "ada", "first_name": "Ada"},
    )

    response = await client.post("/api/v1/auth/telegram/callback", json={"init_data": init_data})

    assert response.status_code == 200
    body = response.json()
    assert body["access_token"]
    redirect = urlsplit(body["redirect_url"])
    assert redirect.query == ""
    assert redirect.fragment == ""
    assert body["access_token"] not in body["redirect_url"]


@pytest.mark.asyncio
async def test_register_password_rejects_legacy_fixed_dev_header(client):
    response = await client.post(
        "/api/v1/auth/register-password",
        headers={"X-Dev-Internal": "miniapp-subscription"},
        json={
            "telegram_id": 4242,
            "login": "paid_user",
            "password": "p" * 32,
            "telegram_username": "paid_user",
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Invalid API key"


@pytest.mark.asyncio
async def test_register_password_rejects_backend_intelligence_key(client, test_app):
    response = await client.post(
        "/api/v1/auth/register-password",
        headers={"X-API-Key": test_app.state.settings.backend_api_key},
        json={
            "telegram_id": 4343,
            "login": "paid_user_2",
            "password": "q" * 32,
            "telegram_username": "paid_user_2",
        },
    )

    assert response.status_code == 403
    assert response.json()["detail"] == "Invalid API key"


@pytest.mark.asyncio
async def test_register_password_accepts_only_subscription_internal_key(client, test_app):
    response = await client.post(
        "/api/v1/auth/register-password",
        headers={"X-API-Key": test_app.state.settings.subscription_internal_key},
        json={
            "telegram_id": 4444,
            "login": "paid_user_3",
            "password": "r" * 32,
            "telegram_username": "paid_user_3",
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "success"
