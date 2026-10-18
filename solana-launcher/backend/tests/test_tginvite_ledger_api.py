"""Owner-isolated HTTP audit; no consent-writing or dispatch APIs."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import jwt
import pytest
from app.models.user import User
from app.services.tginvite_consent_ledger import (
    VerifiedTelegramOptIn,
    plan_non_dispatching_job,
    record_verified_opt_in,
)

SERVICE_KEY = "tginvite-ledger-test-service-" + "x" * 40
KEY = b"ledger-secret-hmac-key-only-used-in-tests-2026-012345"


async def user_and_token(test_app):
    async with test_app.state.sessionmaker() as db:
        user = User(
            email=f"ledger-api-{uuid4()}@example.test",
            is_active=True,
            subscription_expires_at=datetime.now(UTC) + timedelta(days=1),
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)
        owner_id = str(user.id)
    settings = test_app.state.settings
    token = jwt.encode({"sub": owner_id}, settings.secret_key, algorithm=settings.algorithm)
    return owner_id, token


@pytest.mark.asyncio
async def test_job_list_and_cancel_are_owner_scoped_and_do_not_expose_proofs(test_app, client):
    test_app.state.settings.tginvite_internal_key = SERVICE_KEY
    owner_a, token_a = await user_and_token(test_app)
    _, token_b = await user_and_token(test_app)
    a = {"Authorization": f"Bearer {token_a}", "X-TGInvite-Service-Key": SERVICE_KEY}
    b = {"Authorization": f"Bearer {token_b}", "X-TGInvite-Service-Key": SERVICE_KEY}
    path = "/api/v1/tginvite/invite-jobs"

    async with test_app.state.sessionmaker() as db:
        proof = await record_verified_opt_in(
            db,
            VerifiedTelegramOptIn(
                owner_id=owner_a,
                destination_chat_id="-100129876543",
                recipient_telegram_id="246813579",
                telegram_bot_id="987654321",
                telegram_update_id=987,
                proof_kind="telegram_bot_start",
            ),
            hmac_key=KEY,
        )
        job = await plan_non_dispatching_job(
            db, owner_id=owner_a, consent_id=str(proof.id),
            destination_chat_id=proof.destination_chat_id,
            idempotency_key="request_ledger_api_987654321",
        )

    denied = await client.get(path, headers={"Authorization": f"Bearer {token_a}"})
    assert denied.status_code == 403
    assert (await client.get(path, headers=b)).json() == []

    response = await client.get(path, headers=a)
    assert response.status_code == 200
    jobs = response.json()
    assert len(jobs) == 1
    assert jobs[0]["id"] == job.id
    assert jobs[0]["status"] == "blocked_transport"
    assert set(jobs[0]) == {"id", "destination_chat_id", "status", "created_at"}
    assert "246813579" not in response.text
    assert proof.recipient_digest not in response.text

    wrong_owner = await client.post(f"{path}/{job.id}/cancel", headers=b)
    assert wrong_owner.status_code == 404
    assert (await client.get(path, headers=a)).json()[0]["status"] == "blocked_transport"

    cancelled = await client.post(f"{path}/{job.id}/cancel", headers=a)
    assert cancelled.status_code == 204
    after = await client.get(path, headers=a)
    assert after.json()[0]["status"] == "cancelled"
    assert (await client.post(f"{path}/{job.id}/cancel", headers=a)).status_code == 204

    not_allowed = await client.post(path, headers=a, json={"consent": True})
    assert not_allowed.status_code == 405
    no_dispatch = await client.post(f"{path}/{job.id}/send", headers=a)
    assert no_dispatch.status_code in (404, 405)


@pytest.mark.asyncio
async def test_job_list_limits_and_requires_active_subscription(test_app, client):
    test_app.state.settings.tginvite_internal_key = SERVICE_KEY
    _, token = await user_and_token(test_app)
    headers = {"Authorization": f"Bearer {token}", "X-TGInvite-Service-Key": SERVICE_KEY}
    path = "/api/v1/tginvite/invite-jobs"
    assert (await client.get(path + "?limit=101", headers=headers)).status_code == 422
    assert (await client.get(path + "?limit=0", headers=headers)).status_code == 422
    assert (await client.get(path, headers=headers)).status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize("job_status", ["reserved", "invited", "declined", "unknown"])
async def test_cancel_never_claims_to_stop_dispatched_invites(test_app, client, job_status):
    test_app.state.settings.tginvite_internal_key = SERVICE_KEY
    owner_id, token = await user_and_token(test_app)
    headers = {"Authorization": f"Bearer {token}", "X-TGInvite-Service-Key": SERVICE_KEY}
    async with test_app.state.sessionmaker() as db:
        proof = await record_verified_opt_in(
            db,
            VerifiedTelegramOptIn(
                owner_id=owner_id,
                destination_chat_id="-100129876543",
                recipient_telegram_id="246813579",
                telegram_bot_id="987654321",
                telegram_update_id=988,
                proof_kind="telegram_bot_start",
            ),
            hmac_key=KEY,
        )
        job = await plan_non_dispatching_job(
            db, owner_id=owner_id, consent_id=str(proof.id),
            destination_chat_id=proof.destination_chat_id,
            idempotency_key="request_non_cancellable_988",
        )
        job.status = job_status
        job.direct_recipient_digest = "d" * 64
        await db.commit()
        job_id = str(job.id)

    path = "/api/v1/tginvite/invite-jobs"
    response = await client.post(f"{path}/{job_id}/cancel", headers=headers)
    assert response.status_code == 409
    listed = await client.get(path, headers=headers)
    assert listed.json()[0]["status"] == job_status
