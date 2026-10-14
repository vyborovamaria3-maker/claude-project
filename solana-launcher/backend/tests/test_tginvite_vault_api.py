"""End-to-end authorization and isolation of the encrypted Telegram session vault."""

from __future__ import annotations

import base64
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from app.core.rate_limit import RateLimiter
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
    stored = await client.put(
        url, headers={**a, "X-TGInvite-Expected-Generation": "0"}, json=SESSION
    )
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


@pytest.mark.asyncio
async def test_telegram_login_attempts_are_rate_limited_per_owner(test_app, client):
    settings = test_app.state.settings
    settings.tginvite_internal_key = SERVICE_KEY
    token_a = await _user(test_app, "login-rate-limit-owner-a")
    token_b = await _user(test_app, "login-rate-limit-owner-b")
    path = "/api/v1/tginvite/login-attempt"
    headers_a = {
        "Authorization": f"Bearer {token_a}",
        "X-TGInvite-Service-Key": SERVICE_KEY,
    }
    headers_b = {
        "Authorization": f"Bearer {token_b}",
        "X-TGInvite-Service-Key": SERVICE_KEY,
    }

    for _ in range(3):
        response = await client.post(path, headers=headers_a, json={"kind": "send_code"})
        assert response.status_code == 204

    limited = await client.post(path, headers=headers_a, json={"kind": "send_code"})
    assert limited.status_code == 429
    assert int(limited.headers["retry-after"]) > 0

    # Another owner is not penalized for this owner's Telegram login attempts.
    other_owner = await client.post(path, headers=headers_b, json={"kind": "send_code"})
    assert other_owner.status_code == 204

    # Verification attempts have a separate rate limit.
    for _ in range(8):
        verified = await client.post(path, headers=headers_a, json={"kind": "complete_login"})
        assert verified.status_code == 204
    denied = await client.post(path, headers=headers_a, json={"kind": "complete_login"})
    assert denied.status_code == 429


@pytest.mark.asyncio
async def test_login_attempt_endpoint_requires_service_credentials(test_app, client):
    settings = test_app.state.settings
    settings.tginvite_internal_key = SERVICE_KEY
    token = await _user(test_app, "login-permit-service-auth")
    path = "/api/v1/tginvite/login-attempt"
    no_service_key = await client.post(
        path,
        headers={"Authorization": f"Bearer {token}"},
        json={"kind": "send_code"},
    )
    assert no_service_key.status_code == 403
    invalid_kind = await client.post(
        path,
        headers={
            "Authorization": f"Bearer {token}",
            "X-TGInvite-Service-Key": SERVICE_KEY,
        },
        json={"kind": "delete_all_sessions"},
    )
    assert invalid_kind.status_code == 422


@pytest.mark.asyncio
async def test_read_permit_requires_internal_key_and_is_owner_scoped(test_app, client):
    settings = test_app.state.settings
    settings.tginvite_internal_key = SERVICE_KEY
    owner_a = await _user(test_app, "read-permit-owner-a")
    owner_b = await _user(test_app, "read-permit-owner-b")
    url = "/api/v1/tginvite/read-permit"
    headers_a = {
        "Authorization": f"Bearer {owner_a}",
        "X-TGInvite-Service-Key": SERVICE_KEY,
    }
    headers_b = {
        "Authorization": f"Bearer {owner_b}",
        "X-TGInvite-Service-Key": SERVICE_KEY,
    }

    not_internal = await client.post(
        url, headers={"Authorization": f"Bearer {owner_a}"}, json={"kind": "fetch_members"}
    )
    assert not_internal.status_code == 403
    wrong_action = await client.post(url, headers=headers_a, json={"kind": "invite_users"})
    assert wrong_action.status_code == 422

    for _ in range(2):
        allowed = await client.post(url, headers=headers_a, json={"kind": "validate_candidates"})
        assert allowed.status_code == 204
    denied = await client.post(url, headers=headers_a, json={"kind": "validate_candidates"})
    assert denied.status_code == 429
    assert int(denied.headers["retry-after"]) > 0

    independent = await client.post(url, headers=headers_b, json={"kind": "validate_candidates"})
    assert independent.status_code == 204
    other_kind = await client.post(url, headers=headers_a, json={"kind": "fetch_members"})
    assert other_kind.status_code == 204


@pytest.mark.asyncio
async def test_telegram_read_quota_fails_closed_in_production_without_redis(test_app, client):
    settings = test_app.state.settings
    settings.tginvite_internal_key = SERVICE_KEY
    token = await _user(test_app, "strict-tginvite-read-owner")
    url = "/api/v1/tginvite/read-permit"
    headers = {
        "Authorization": f"Bearer {token}",
        "X-TGInvite-Service-Key": SERVICE_KEY,
    }
    previous_environment = settings.environment
    previous_limiter = test_app.state.rate_limiter
    try:
        settings.environment = "production"
        test_app.state.rate_limiter = RateLimiter(None)
        denied = await client.post(url, headers=headers, json={"kind": "analyze_recent"})
        assert denied.status_code == 503
        assert "unavailable" in denied.json()["detail"].lower()
    finally:
        settings.environment = previous_environment
        test_app.state.rate_limiter = previous_limiter

@pytest.mark.asyncio
async def test_invite_link_quota_is_shared_and_owner_scoped(test_app, client):
    settings = test_app.state.settings
    settings.tginvite_internal_key = SERVICE_KEY
    owner_a = await _user(test_app, "invite-links-a")
    owner_b = await _user(test_app, "invite-links-b")
    path = "/api/v1/tginvite/read-permit"
    a = {"Authorization": f"Bearer {owner_a}", "X-TGInvite-Service-Key": SERVICE_KEY}
    b = {"Authorization": f"Bearer {owner_b}", "X-TGInvite-Service-Key": SERVICE_KEY}
    for _ in range(2):
        response = await client.post(
            path, headers=a, json={"kind": "batch_invite_links"}
        )
        assert response.status_code == 204
    excess = await client.post(path, headers=a, json={"kind": "batch_invite_links"})
    assert excess.status_code == 429
    assert int(excess.headers["retry-after"]) > 0
    independent = await client.post(path, headers=b, json={"kind": "batch_invite_links"})
    assert independent.status_code == 204
    single = await client.post(path, headers=a, json={"kind": "create_invite_link"})
    assert single.status_code == 204
