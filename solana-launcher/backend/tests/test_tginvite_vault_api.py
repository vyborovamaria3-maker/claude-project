"""End-to-end authorization and isolation of the encrypted Telegram session vault."""

from __future__ import annotations

import base64
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from app.models.telegram_invite_session import TelegramInviteSession
from app.models.user import User
from sqlalchemy import select

SERVICE_KEY = "test-tginvite-internal-key-" + "z" * 40
VAULT_KEY = base64.b64encode(b"n" * 32).decode("ascii")
SESSION = {"api_id": 12345, "api_hash": "a" * 32, "session_string": "test.session.secret.abc123"}


async def _user(test_app, label: str) -> str:
    settings = test_app.state.settings
    async with test_app.state.sessionmaker() as db:
        row = User(
            email=f"{label}@example.test",
            is_active=True,
            subscription_expires_at=datetime.now(UTC) + timedelta(days=1),
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return jwt.encode({"sub": str(row.id)}, settings.secret_key, algorithm=settings.algorithm)


@pytest.mark.asyncio
async def test_vault_is_owner_scoped_encrypted_and_revocable(test_app, client):
    settings = test_app.state.settings
    settings.tginvite_internal_key = SERVICE_KEY
    settings.tginvite_session_encryption_key = VAULT_KEY
    owner_a = await _user(test_app, "first-tginvite-user")
    owner_b = await _user(test_app, "second-tginvite-user")
    url = "/api/v1/tginvite/session"
    a = {"Authorization": f"Bearer {owner_a}", "X-TGInvite-Service-Key": SERVICE_KEY}
    b = {"Authorization": f"Bearer {owner_b}", "X-TGInvite-Service-Key": SERVICE_KEY}

    denied = await client.get(url, headers={"Authorization": f"Bearer {owner_a}"})
    assert denied.status_code == 403
    stored = await client.put(url, headers=a, json=SESSION)
    assert stored.status_code == 204
    loaded = await client.get(url, headers=a)
    assert loaded.status_code == 200
    assert loaded.json() == SESSION
    foreign = await client.get(url, headers=b)
    assert foreign.status_code == 404

    async with test_app.state.sessionmaker() as db:
        encrypted = (await db.execute(select(TelegramInviteSession))).scalar_one()
        assert SESSION["session_string"] not in encrypted.encrypted_payload

    deleted = await client.delete(url, headers=a)
    assert deleted.status_code == 204
    assert (await client.get(url, headers=a)).status_code == 404


@pytest.mark.asyncio
async def test_vault_fails_closed_without_keys(test_app, client):
    settings = test_app.state.settings
    token = await _user(test_app, "missing-keys-user")
    headers = {
        "Authorization": f"Bearer {token}",
        "X-TGInvite-Service-Key": SERVICE_KEY,
    }
    settings.tginvite_internal_key = ""
    response = await client.get("/api/v1/tginvite/session", headers=headers)
    assert response.status_code == 503

    settings.tginvite_internal_key = SERVICE_KEY
    settings.tginvite_session_encryption_key = ""
    response = await client.get("/api/v1/tginvite/session", headers=headers)
    assert response.status_code == 503


@pytest.mark.asyncio
async def test_public_history_is_internal_owner_bound_and_validates_usernames(test_app, client):
    settings = test_app.state.settings
    settings.tginvite_internal_key = SERVICE_KEY
    settings.tginvite_session_encryption_key = VAULT_KEY
    token = await _user(test_app, "history-private-user")
    path = "/api/v1/tginvite/messages"
    authorization = {"Authorization": f"Bearer {token}"}
    allowed_headers = {**authorization, "X-TGInvite-Service-Key": SERVICE_KEY}

    denied = await client.post(path, headers=authorization, json={"username": "@PublicChannel"})
    assert denied.status_code == 403

    invalid = await client.post(
        path, headers=allowed_headers, json={"username": "https://t.me/+joinhash"}
    )
    assert invalid.status_code == 422

    # No Telegram network access: the user has not connected a vault session.
    missing_session = await client.post(
        path, headers=allowed_headers, json={"username": "@PublicChannel", "limit": 50}
    )
    assert missing_session.status_code == 404
