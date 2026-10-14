"""Consent ledger is durable, owner-bound, replay-resistant and never dispatches."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from app.models.telegram_invite_consent import TelegramInviteConsent, TelegramInviteJob
from app.models.user import User
from app.services.tginvite_consent_ledger import (
    ConsentLedgerError,
    VerifiedTelegramOptIn,
    plan_non_dispatching_job,
    record_verified_opt_in,
    revoke_recipient_opt_in,
)
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

KEY = b"consent-test-hmac-key-never-use-outside-tests-2026-45"


async def create_user(db) -> str:
    row = User(email=f"consent-ledger-{uuid4()}@example.test", is_active=True)
    db.add(row)
    await db.flush()
    return str(row.id)


def proof(owner: str, *, update: int = 11) -> VerifiedTelegramOptIn:
    return VerifiedTelegramOptIn(
        owner_id=owner,
        destination_chat_id="-100123456789",
        recipient_telegram_id="123456789",
        telegram_bot_id="987654321",
        telegram_update_id=update,
        proof_kind="telegram_chat_join_request",
    )


@pytest.mark.asyncio
async def test_webhook_proof_hashing_replay_and_reconsent(test_app):
    async with test_app.state.sessionmaker() as db:
        owner = await create_user(db)
        await db.commit()
        first = await record_verified_opt_in(db, proof(owner), hmac_key=KEY)
        repeated = await record_verified_opt_in(db, proof(owner), hmac_key=KEY)
        assert repeated.id == first.id
        assert first.recipient_digest != "123456789"
        assert len(first.recipient_digest) == 64
        assert first.proof_digest != first.recipient_digest
        assert "123456789" not in first.recipient_digest
        assert "123456789" not in first.proof_digest

        another_owner = await create_user(db)
        await db.commit()
        # One authentic Telegram update cannot be reused for another owner,
        # another chat, or a different alleged recipient.
        with pytest.raises(ConsentLedgerError):
            await record_verified_opt_in(db, proof(another_owner), hmac_key=KEY)
        with pytest.raises(ConsentLedgerError):
            await record_verified_opt_in(
                db,
                VerifiedTelegramOptIn(**{
                    **proof(owner).__dict__, "recipient_telegram_id": "555555555",
                }),
                hmac_key=KEY,
            )

        revoked = await revoke_recipient_opt_in(
            db, owner_id=owner, destination_chat_id="-100123456789",
            recipient_digest=first.recipient_digest,
        )
        assert revoked == 1
        # A duplicate webhook delivery cannot silently restore revoked consent.
        still_revoked = await record_verified_opt_in(db, proof(owner), hmac_key=KEY)
        assert still_revoked.id == first.id
        assert still_revoked.revoked_at is not None
        fresh = await record_verified_opt_in(db, proof(owner, update=12), hmac_key=KEY)
        assert fresh.id != first.id
        assert fresh.revoked_at is None

        records = (await db.execute(select(TelegramInviteConsent))).scalars().all()
        assert len(records) == 2


@pytest.mark.asyncio
async def test_jobs_are_blocked_and_bound_to_verified_owner_chat_consent(test_app):
    async with test_app.state.sessionmaker() as db:
        owner = await create_user(db)
        other = await create_user(db)
        await db.commit()
        evidence = await record_verified_opt_in(db, proof(owner), hmac_key=KEY)

        args = dict(
            owner_id=owner, consent_id=str(evidence.id),
            destination_chat_id=evidence.destination_chat_id,
            idempotency_key="request_abcdefghij0123456789",
        )
        job = await plan_non_dispatching_job(db, **args)
        assert job.status == "blocked_transport"
        assert (await plan_non_dispatching_job(db, **args)).id == job.id
        with pytest.raises(ConsentLedgerError):
            await plan_non_dispatching_job(
                db, **{**args, "idempotency_key": "request_other_0123456789", "owner_id": other}
            )
        with pytest.raises(ConsentLedgerError):
            await plan_non_dispatching_job(
                db, **{**args, "idempotency_key": "request_other_0123456789",
                       "destination_chat_id": "-100987654321"}
            )
        with pytest.raises(ConsentLedgerError):
            await plan_non_dispatching_job(
                db, **{**args, "destination_chat_id": "-100987654321"}
            )
        await revoke_recipient_opt_in(
            db, owner_id=owner, destination_chat_id=evidence.destination_chat_id,
            recipient_digest=evidence.recipient_digest,
        )
        with pytest.raises(ConsentLedgerError):
            await plan_non_dispatching_job(
                db, **{**args, "idempotency_key": "request_after_revocation"}
            )
        jobs = (await db.execute(select(TelegramInviteJob))).scalars().all()
        assert len(jobs) == 1
        assert jobs[0].status == "blocked_transport"


@pytest.mark.asyncio
async def test_expired_consent_cannot_plan_job(test_app):
    async with test_app.state.sessionmaker() as db:
        owner = await create_user(db)
        await db.commit()
        evidence = await record_verified_opt_in(db, proof(owner), hmac_key=KEY)
        evidence.verified_at = datetime.now(UTC) - timedelta(days=91)
        await db.commit()
        with pytest.raises(ConsentLedgerError):
            await plan_non_dispatching_job(
                db, owner_id=owner, consent_id=str(evidence.id),
                destination_chat_id="-100123456789",
                idempotency_key="expired_consent_0123456789",
            )


@pytest.mark.asyncio
async def test_job_status_constraint_blocks_unimplemented_delivery(test_app):
    async with test_app.state.sessionmaker() as db:
        owner = await create_user(db)
        await db.commit()
        evidence = await record_verified_opt_in(db, proof(owner), hmac_key=KEY)
        job = await plan_non_dispatching_job(
            db, owner_id=owner, consent_id=str(evidence.id),
            destination_chat_id=evidence.destination_chat_id,
            idempotency_key="do_not_send_012345678901234",
        )
        job.status = "sent"
        with pytest.raises(IntegrityError):
            await db.commit()
        await db.rollback()
        persisted = (await db.execute(select(TelegramInviteJob))).scalar_one()
        assert persisted.status == "blocked_transport"


@pytest.mark.asyncio
async def test_rejects_unproven_events_and_weak_hmac_key(test_app):
    async with test_app.state.sessionmaker() as db:
        owner = await create_user(db)
        await db.commit()
        with pytest.raises(ConsentLedgerError):
            await record_verified_opt_in(db, proof(owner), hmac_key=b"weak")
        with pytest.raises(ConsentLedgerError):
            await record_verified_opt_in(
                db,
                VerifiedTelegramOptIn(**{
                    **proof(owner).__dict__, "recipient_telegram_id": "invalid-username",
                }),
                hmac_key=KEY,
            )
        with pytest.raises(ConsentLedgerError):
            await record_verified_opt_in(
                db,
                VerifiedTelegramOptIn(**{
                    **proof(owner).__dict__, "proof_kind": "client_checkbox",
                }),
                hmac_key=KEY,
            )
