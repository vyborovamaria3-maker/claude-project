"""Shared login challenge fencing tests; no real Telegram traffic."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import jwt
import pytest
from app.models.user import User

SERVICE_KEY = "test-tginvite-internal-key-" + "k" * 40


class FakeSharedRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    async def set(self, key: str, value: str, *, nx: bool, ex: int) -> bool:
        assert nx and ex == 600
        if key in self.values:
            return False
        self.values[key] = value
        return True

    async def get(self, key: str) -> str | None:
        return self.values.get(key)

    async def delete(self, key: str) -> int:
        return int(self.values.pop(key, None) is not None)

    async def eval(self, _script: str, numkeys: int, key: str, token: str) -> int:
        assert numkeys == 1
        if self.values.get(key) != token:
            return 0
        return await self.delete(key)


async def _headers(test_app) -> dict[str, str]:
    async with test_app.state.sessionmaker() as db:
        user = User(
            email=f"lease-{uuid4()}@example.test",
            is_active=True,
            subscription_expires_at=datetime.now(UTC) + timedelta(days=1),
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)
    settings = test_app.state.settings
    token = jwt.encode({"sub": str(user.id)}, settings.secret_key, algorithm=settings.algorithm)
    return {
        "Authorization": f"Bearer {token}",
        "X-TGInvite-Service-Key": SERVICE_KEY,
    }


@pytest.mark.asyncio
async def test_login_lease_blocks_competing_workers_and_cannot_release_new_owner(
    test_app, client
):
    settings = test_app.state.settings
    settings.tginvite_internal_key = SERVICE_KEY
    headers = await _headers(test_app)
    old_redis = test_app.state.redis
    test_app.state.redis = FakeSharedRedis()
    path = "/api/v1/tginvite/login-lease"
    try:
        first = await client.post(path, headers=headers, json={"action": "acquire"})
        assert first.status_code == 200
        assert first.headers["cache-control"] == "private, no-store"
        token = first.json()["token"]
        assert len(token) >= 32

        competing = await client.post(path, headers=headers, json={"action": "acquire"})
        assert competing.status_code == 409

        wrong = await client.post(
            path, headers=headers, json={"action": "verify", "token": "x" * 40}
        )
        assert wrong.status_code == 409

        verified = await client.post(
            path, headers=headers, json={"action": "verify", "token": token}
        )
        assert verified.status_code == 204

        wrong_release = await client.post(
            path, headers=headers, json={"action": "release", "token": "x" * 40}
        )
        assert wrong_release.status_code == 409
        assert (
            await client.post(path, headers=headers, json={"action": "verify", "token": token})
        ).status_code == 204

        released = await client.post(
            path, headers=headers, json={"action": "release", "token": token}
        )
        assert released.status_code == 204
        next_login = await client.post(path, headers=headers, json={"action": "acquire"})
        assert next_login.status_code == 200
        assert next_login.json()["token"] != token
        stale_release = await client.post(
            path, headers=headers, json={"action": "release", "token": token}
        )
        assert stale_release.status_code == 409
        assert (
            await client.post(
                path, headers=headers,
                json={"action": "verify", "token": next_login.json()["token"]},
            )
        ).status_code == 204
        assert (
            await client.post(path, headers=headers, json={"action": "reset"})
        ).status_code == 204
        assert (
            await client.post(
                path, headers=headers,
                json={"action": "verify", "token": next_login.json()["token"]},
            )
        ).status_code == 409
    finally:
        test_app.state.redis = old_redis


@pytest.mark.asyncio
async def test_login_lease_fails_closed_without_shared_redis(test_app, client):
    test_app.state.settings.tginvite_internal_key = SERVICE_KEY
    headers = await _headers(test_app)
    prior = test_app.state.redis
    test_app.state.redis = None
    try:
        denied = await client.post(
            "/api/v1/tginvite/login-lease",
            headers=headers, json={"action": "acquire"},
        )
        assert denied.status_code == 503
        missing_token = await client.post(
            "/api/v1/tginvite/login-lease",
            headers=headers, json={"action": "verify"},
        )
        assert missing_token.status_code == 422
    finally:
        test_app.state.redis = prior


@pytest.mark.asyncio
async def test_login_lease_needs_internal_service_key(test_app, client):
    test_app.state.settings.tginvite_internal_key = SERVICE_KEY
    headers = await _headers(test_app)
    headers.pop("X-TGInvite-Service-Key")
    denied = await client.post(
        "/api/v1/tginvite/login-lease",
        headers=headers, json={"action": "acquire"},
    )
    assert denied.status_code == 403
