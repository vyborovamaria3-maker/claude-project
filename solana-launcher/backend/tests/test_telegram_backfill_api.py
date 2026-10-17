"""Admin-only, bounded historic Telegram backfill API regression tests."""

from __future__ import annotations

import jwt
import pytest
from app.models.user import User


class _FakeScanner:
    def __init__(self):
        self.calls = []

    async def scan_channel(self, channel, *, post_limit, backfill):
        self.calls.append((channel, post_limit, backfill))
        return {
            "username": channel,
            "oldest_before": 100,
            "oldest_after": 75,
            "new_messages": 25,
            "backfill_may_remain": True,
        }


class _FakeManager:
    def __init__(self, scanner):
        self.scanner = scanner

    async def get_service(self):
        return self.scanner


async def _auth_token(test_app, *, superuser):
    async with test_app.state.sessionmaker() as db:
        user = User(
            email=("telegram-backfill-admin" if superuser else "telegram-backfill-viewer")
            + "@example.test",
            is_active=True,
            is_superuser=superuser,
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)
    settings = test_app.state.settings
    return jwt.encode({"sub": str(user.id)}, settings.secret_key, algorithm=settings.algorithm)


@pytest.mark.asyncio
async def test_telegram_backfill_is_admin_only_and_throttled(test_app, client):
    scanner = _FakeScanner()
    test_app.state.telegram_intelligence = _FakeManager(scanner)
    endpoint = "/api/v1/telegram/backfill"
    payload = {"channel": "@publicchannel", "post_limit": 25}

    anonymous = await client.post(endpoint, json=payload)
    assert anonymous.status_code == 401

    viewer_token = await _auth_token(test_app, superuser=False)
    viewer = await client.post(
        endpoint,
        headers={"Authorization": f"Bearer {viewer_token}"},
        json=payload,
    )
    assert viewer.status_code == 403

    admin_token = await _auth_token(test_app, superuser=True)
    headers = {"Authorization": f"Bearer {admin_token}"}
    first = await client.post(endpoint, headers=headers, json=payload)
    second = await client.post(endpoint, headers=headers, json=payload)
    third = await client.post(endpoint, headers=headers, json=payload)

    assert first.status_code == 200
    assert first.json()["oldest_after"] == 75
    assert second.status_code == 200
    assert third.status_code == 429
    assert int(third.headers["Retry-After"]) >= 1
    assert scanner.calls == [
        ("@publicchannel", 25, True),
        ("@publicchannel", 25, True),
    ]


@pytest.mark.asyncio
async def test_telegram_backfill_rejects_invite_links_before_collecting(test_app, client):
    scanner = _FakeScanner()
    test_app.state.telegram_intelligence = _FakeManager(scanner)
    admin_token = await _auth_token(test_app, superuser=True)
    response = await client.post(
        "/api/v1/telegram/backfill",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"channel": "https://t.me/+invitehash", "post_limit": 10},
    )
    assert response.status_code == 422
    assert scanner.calls == []
