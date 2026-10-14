"""Private, non-dispatching ledger for Telegram recipient opt-in evidence.

There is deliberately no HTTP endpoint to create proofs or to dispatch jobs.
A future Telegram webhook verifier may call record_verified_opt_in *only* after
it authenticates the Telegram update and resolves its owner+chat binding.
Neither this service nor its jobs initiate Telegram network requests.
"""

from __future__ import annotations

import hashlib
import hmac
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.telegram_invite_consent import TelegramInviteConsent, TelegramInviteJob

CONSENT_VALID_FOR = timedelta(days=90)
SUPPORTED_EVIDENCE = frozenset({"telegram_bot_start", "telegram_chat_join_request"})
_USER_ID = re.compile(r"^[1-9][0-9]{0,19}$")
_REQUEST_ID = re.compile(r"^[A-Za-z0-9_-]{16,96}$")


class ConsentLedgerError(ValueError):
    """A request is not backed by a valid, active and scoped opt-in record."""


@dataclass(frozen=True)
class VerifiedTelegramOptIn:
    """Only construct after authenticated Telegram webhook validation.

    An untrusted browser-provided claim is never a VerifiedTelegramOptIn.
    """

    owner_id: str
    destination_chat_id: str
    recipient_telegram_id: str
    telegram_bot_id: str
    telegram_update_id: int
    proof_kind: str


def _uuid(value: str) -> str:
    try:
        return str(UUID(value))
    except (TypeError, ValueError) as exc:
        raise ConsentLedgerError("Invalid owner or consent identifier") from exc


def _chat(value: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 128:
        raise ConsentLedgerError("Invalid chat identifier")
    return value


def _digest(secret: bytes, purpose: str, *values: str) -> str:
    if not isinstance(secret, bytes) or len(secret) < 32:
        raise ConsentLedgerError("Consent HMAC key must contain at least 32 random bytes")
    message = "\x00".join((purpose, *values)).encode("utf-8")
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


async def record_verified_opt_in(
    db: AsyncSession,
    event: VerifiedTelegramOptIn,
    *,
    hmac_key: bytes,
) -> TelegramInviteConsent:
    """Store event hashes, never plaintext recipient IDs or raw bot updates.

    This trusted service function is not exposed through an API. Webhook secret
    checking and Telegram identity verification must precede any caller.
    """
    owner_id = _uuid(event.owner_id)
    chat = _chat(event.destination_chat_id)
    if (
        event.proof_kind not in SUPPORTED_EVIDENCE
        or not _USER_ID.fullmatch(event.recipient_telegram_id)
        or not _USER_ID.fullmatch(event.telegram_bot_id)
        or not isinstance(event.telegram_update_id, int)
        or isinstance(event.telegram_update_id, bool)
        or event.telegram_update_id < 0
    ):
        raise ConsentLedgerError("Invalid verified Telegram event")

    recipient_hash = _digest(
        hmac_key, "recipient:v1", event.telegram_bot_id, event.recipient_telegram_id
    )
    proof_hash = _digest(
        hmac_key, "proof:v1", event.telegram_bot_id,
        str(event.telegram_update_id), event.proof_kind,
        owner_id, chat, event.recipient_telegram_id,
    )
    # Idempotent event ingestion: webhook redelivery cannot create new consent.
    old = (
        await db.execute(
            select(TelegramInviteConsent).where(
                TelegramInviteConsent.proof_digest == proof_hash
            )
        )
    ).scalar_one_or_none()
    if old is not None:
        return old

    record = TelegramInviteConsent(
        owner_id=owner_id,
        destination_chat_id=chat,
        recipient_digest=recipient_hash,
        proof_kind=event.proof_kind,
        proof_digest=proof_hash,
        verified_at=datetime.now(UTC),
    )
    db.add(record)
    try:
        await db.commit()
    except IntegrityError:
        # Telegram may redeliver the exact update to multiple workers at once.
        # The globally unique proof digest wins; a replay cannot mint consent.
        await db.rollback()
        winner = (
            await db.execute(
                select(TelegramInviteConsent).where(
                    TelegramInviteConsent.proof_digest == proof_hash
                )
            )
        ).scalar_one_or_none()
        if winner is None:
            raise
        return winner
    await db.refresh(record)
    return record


async def revoke_recipient_opt_in(
    db: AsyncSession,
    *,
    owner_id: str,
    destination_chat_id: str,
    recipient_digest: str,
) -> int:
    """Revoke all matching evidence, not just the latest proof."""
    if not re.fullmatch(r"[a-f0-9]{64}", recipient_digest):
        raise ConsentLedgerError("Invalid recipient proof digest")
    result = await db.execute(
        update(TelegramInviteConsent)
        .where(
            TelegramInviteConsent.owner_id == _uuid(owner_id),
            TelegramInviteConsent.destination_chat_id == _chat(destination_chat_id),
            TelegramInviteConsent.recipient_digest == recipient_digest,
            TelegramInviteConsent.revoked_at.is_(None),
        )
        .values(revoked_at=datetime.now(UTC))
    )
    await db.commit()
    return result.rowcount or 0


async def plan_non_dispatching_job(
    db: AsyncSession,
    *,
    owner_id: str,
    consent_id: str,
    destination_chat_id: str,
    idempotency_key: str,
) -> TelegramInviteJob:
    """Create only a blocked audit job; cannot send invitations.

    Owner+chat must match a current recipient-authenticated consent proof.
    Idempotency keys cannot be reused for a different consent/destination.
    """
    owner = _uuid(owner_id)
    chat = _chat(destination_chat_id)
    consent = _uuid(consent_id)
    if not isinstance(idempotency_key, str) or not _REQUEST_ID.fullmatch(idempotency_key):
        raise ConsentLedgerError("Invalid idempotency key")
    existing = (
        await db.execute(
            select(TelegramInviteJob).where(
                TelegramInviteJob.owner_id == owner,
                TelegramInviteJob.idempotency_key == idempotency_key,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        if existing.destination_chat_id != chat or existing.consent_id != consent:
            raise ConsentLedgerError("Idempotency key already belongs to another job")
        return existing

    evidence = (
        await db.execute(
            select(TelegramInviteConsent)
            .where(
                TelegramInviteConsent.id == consent,
                TelegramInviteConsent.owner_id == owner,
                TelegramInviteConsent.destination_chat_id == chat,
                TelegramInviteConsent.revoked_at.is_(None),
                TelegramInviteConsent.verified_at >= datetime.now(UTC) - CONSENT_VALID_FOR,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if evidence is None:
        raise ConsentLedgerError("No verified, active consent for this recipient and chat")
    job = TelegramInviteJob(
        owner_id=owner, consent_id=consent,
        destination_chat_id=chat, idempotency_key=idempotency_key,
        status="blocked_transport",
    )
    db.add(job)
    try:
        await db.commit()
    except IntegrityError:
        # Competing callers with the same idempotency key must converge on
        # one durable job without changing its consent binding.
        await db.rollback()
        winner = (
            await db.execute(
                select(TelegramInviteJob).where(
                    TelegramInviteJob.owner_id == owner,
                    TelegramInviteJob.idempotency_key == idempotency_key,
                )
            )
        ).scalar_one_or_none()
        if winner is None:
            raise
        if winner.consent_id != consent or winner.destination_chat_id != chat:
            raise ConsentLedgerError("Idempotency key already belongs to another job")
        return winner
    await db.refresh(job)
    return job
