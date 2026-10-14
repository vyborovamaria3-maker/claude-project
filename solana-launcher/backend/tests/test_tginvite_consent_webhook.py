"""Authenticated Bot API join requests create only scoped opt-in evidence.

All tests are offline. No Telegram network, invitation or message send occurs.
"""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from app.models.telegram_invite_consent import TelegramInviteConsent, TelegramInviteJob
from app.models.user import User
from sqlalchemy import select

WEBHOOK_SECRET = "secure_test_webhook_secret_01234567890123456789"
HMAC_KEY = base64.b64encode(b"g" * 32).decode("ascii")
BOT_ID = "123456789"


def join_request(
    chat_id: int = -100123456789,
    requester_id: int = 456789123,
    *,
    update_id: int = 100,
    when: int | None = None,
) -> dict:
    return {
        "update_id": update_id,
        "chat_join_request": {
            "chat": {"id": chat_id, "type": "supergroup"},
            "from": {"id": requester_id, "is_bot": False},
            "date": when if when is not None else int(datetime.now(UTC).timestamp()),
        },
    }


async def configured(test_app) -> str:
    async with test_app.state.sessionmaker() as db:
        owner = User(email=f"join-proof-{uuid4()}@example.test", is_active=True)
        db.add(owner)
        await db.commit()
        await db.refresh(owner)
        owner_id = str(owner.id)
    settings = test_app.state.settings
    settings.tginvite_consent_webhook_secret = WEBHOOK_SECRET
    settings.tginvite_consent_hmac_key = HMAC_KEY
    settings.tginvite_consent_bot_id = BOT_ID
    settings.tginvite_consent_chat_bindings = json.dumps({"-100123456789": owner_id})
    return owner_id


def authorized() -> dict[str, str]:
    return {"X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET}


@pytest.mark.asyncio
async def test_offline_join_request_creates_hashed_owner_bound_proof_and_replay_is_idempotent(
    test_app, client
):
    owner = await configured(test_app)
    url = "/api/v1/tginvite/consent-webhook"
    response = await client.post(url, json=join_request(), headers=authorized())
    assert response.status_code == 204
    assert not response.content
    again = await client.post(url, json=join_request(), headers=authorized())
    assert again.status_code == 204

    async with test_app.state.sessionmaker() as db:
        proofs = (await db.execute(select(TelegramInviteConsent))).scalars().all()
        jobs = (await db.execute(select(TelegramInviteJob))).scalars().all()
    assert len(proofs) == 1
    assert not jobs
    assert proofs[0].owner_id == owner
    assert proofs[0].destination_chat_id == "-100123456789"
    assert proofs[0].proof_kind == "telegram_chat_join_request"
    assert len(proofs[0].proof_digest) == 64
    assert len(proofs[0].recipient_digest) == 64
    assert proofs[0].recipient_digest != "456789123"


@pytest.mark.asyncio
async def test_webhook_needs_dedicated_secret_and_all_settings(test_app, client):
    url = "/api/v1/tginvite/consent-webhook"
    missing = await client.post(url, json=join_request(), headers=authorized())
    assert missing.status_code == 503
    await configured(test_app)
    absent = await client.post(url, json=join_request())
    wrong = await client.post(
        url, json=join_request(),
        headers={"X-Telegram-Bot-Api-Secret-Token": "x" * 40},
    )
    assert absent.status_code == 403
    assert wrong.status_code == 403

    test_app.state.settings.tginvite_consent_hmac_key = "corrupt-base64"
    disabled = await client.post(url, json=join_request(), headers=authorized())
    assert disabled.status_code == 503


@pytest.mark.asyncio
async def test_unbound_or_stale_join_requests_never_create_proofs(test_app, client):
    await configured(test_app)
    url = "/api/v1/tginvite/consent-webhook"
    invalid = [
        join_request(-100999999999),
        join_request(100123456789),
        join_request(requester_id=0),
        join_request(when=int((datetime.now(UTC) - timedelta(days=3)).timestamp())),
        join_request(when=int((datetime.now(UTC) + timedelta(hours=1)).timestamp())),
        {"update_id": True, "chat_join_request": join_request()["chat_join_request"]},
        {"update_id": 101, "chat_join_request": {"from": {"id": 123}}},
    ]
    for event in invalid:
        response = await client.post(url, json=event, headers=authorized())
        assert response.status_code == 422

    ignored = await client.post(
        url, json={"update_id": 102, "message": {"from": {"id": 1}, "text": "/start"}},
        headers=authorized(),
    )
    assert ignored.status_code == 204

    async with test_app.state.sessionmaker() as db:
        assert (await db.execute(select(TelegramInviteConsent))).scalars().all() == []


@pytest.mark.asyncio
async def test_event_cannot_be_reused_for_other_chat_owner_or_recipient(test_app, client):
    await configured(test_app)
    url = "/api/v1/tginvite/consent-webhook"
    assert (
        await client.post(url, json=join_request(), headers=authorized())
    ).status_code == 204

    alternate_id = await client.post(
        url, json=join_request(requester_id=123123123), headers=authorized()
    )
    assert alternate_id.status_code == 409

    # Adding a second operator-owned chat does not authorize replay of an old
    # Telegram update into that chat.
    async with test_app.state.sessionmaker() as db:
        other = User(email=f"webhook-other-{uuid4()}@example.test", is_active=True)
        db.add(other)
        await db.commit()
        await db.refresh(other)
    bindings = json.loads(test_app.state.settings.tginvite_consent_chat_bindings)
    bindings["-100222222222"] = str(other.id)
    test_app.state.settings.tginvite_consent_chat_bindings = json.dumps(bindings)

    alternate_chat = await client.post(
        url, json=join_request(chat_id=-100222222222), headers=authorized()
    )
    assert alternate_chat.status_code == 409

    async with test_app.state.sessionmaker() as db:
        proofs = (await db.execute(select(TelegramInviteConsent))).scalars().all()
    assert len(proofs) == 1


@pytest.mark.asyncio
async def test_rejects_large_bodies_non_json_and_untrusted_owner_claims(test_app, client):
    owner = await configured(test_app)
    url = "/api/v1/tginvite/consent-webhook"
    huge = await client.post(
        url, content=b"{" + b"x" * (33 * 1024) + b"}",
        headers={**authorized(), "Content-Type": "application/json"},
    )
    assert huge.status_code == 413
    non_json = await client.post(
        url, content=b"<not json>", headers={**authorized(), "Content-Type": "text/html"}
    )
    assert non_json.status_code == 415

    event = join_request(update_id=1001)
    event["owner_id"] = str(uuid4())
    event["chat_join_request"]["owner_id"] = str(uuid4())
    valid = await client.post(url, json=event, headers=authorized())
    assert valid.status_code == 204

    async with test_app.state.sessionmaker() as db:
        proof = (await db.execute(select(TelegramInviteConsent))).scalar_one()
    assert proof.owner_id == owner
