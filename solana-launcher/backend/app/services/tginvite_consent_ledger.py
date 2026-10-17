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
    # Telegram update IDs are unique within one bot's update stream.
    # Deliberately omit owner/chat/recipient: a single update cannot be
    # recycled as purported consent for another campaign or owner.
    proof_hash = _digest(
        hmac_key, "proof:v1", event.telegram_bot_id, str(event.telegram_update_id)
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
        if (
            old.owner_id != owner_id
            or old.destination_chat_id != chat
            or old.recipient_digest != recipient_hash
            or old.proof_kind != event.proof_kind
        ):
            raise ConsentLedgerError("Telegram proof already belongs to another consent")
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
        if (
            winner.owner_id != owner_id
            or winner.destination_chat_id != chat
            or winner.recipient_digest != recipient_hash
            or winner.proof_kind != event.proof_kind
        ):
            raise ConsentLedgerError("Telegram proof already belongs to another consent") from None
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
        .returning(TelegramInviteConsent.id)
    )
    revoked = len(result.scalars().all())
    await db.commit()
    return revoked


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
            raise ConsentLedgerError("Idempotency key already belongs to another job") from None
        return winner
    await db.refresh(job)
    return job

# A bot message /join <chat ID> is a new, chat-specific direct-invite request.
# An existing join-request proof is NOT sufficient for this transport.
DIRECT_CONSENT_VALID_FOR = timedelta(days=2)


async def claim_direct_invite(
    db: AsyncSession,
    *,
    owner_id: str,
    destination_chat_id: str,
    recipient_telegram_id: str,
    telegram_bot_id: str,
    hmac_key: bytes,
    idempotency_key: str,
) -> TelegramInviteJob:
    """Atomically reserve a single Telegram invocation for a verified DM opt-in.

    If the process crashes, "reserved" stays ambiguous: no automatic retry.
    The DB unique constraint prevents repeated dispatches to the same recipient
    for the same owner/destination even with a new idempotency key.
    """
    owner = _uuid(owner_id)
    chat = _chat(destination_chat_id)
    if (
        not _USER_ID.fullmatch(recipient_telegram_id)
        or not _USER_ID.fullmatch(telegram_bot_id)
        or not isinstance(idempotency_key, str)
        or not _REQUEST_ID.fullmatch(idempotency_key)
    ):
        raise ConsentLedgerError("Invalid direct invitation request")

    digest = _digest(hmac_key, "recipient:v1", telegram_bot_id, recipient_telegram_id)
    # Do not accept a generic join-request proof as authorization to dispatch.
    proof = (
        await db.execute(
            select(TelegramInviteConsent)
            .where(
                TelegramInviteConsent.owner_id == owner,
                TelegramInviteConsent.destination_chat_id == chat,
                TelegramInviteConsent.recipient_digest == digest,
                TelegramInviteConsent.proof_kind == "telegram_bot_start",
                TelegramInviteConsent.revoked_at.is_(None),
                TelegramInviteConsent.verified_at >= datetime.now(UTC) - DIRECT_CONSENT_VALID_FOR,
            )
            .order_by(TelegramInviteConsent.verified_at.desc())
            .limit(1)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if proof is None:
        raise ConsentLedgerError("Recipient has not requested a direct invite to this chat")

    # Explicit duplicate check gives a useful safe error before unique
    # constraint handles races across workers.
    previous = (
        await db.execute(
            select(TelegramInviteJob.id).where(
                TelegramInviteJob.owner_id == owner,
                TelegramInviteJob.destination_chat_id == chat,
                TelegramInviteJob.direct_recipient_digest == digest,
            )
        )
    ).scalar_one_or_none()
    if previous is not None:
        raise ConsentLedgerError("Invitation already attempted or reserved")

    job = TelegramInviteJob(
        owner_id=owner,
        consent_id=str(proof.id),
        destination_chat_id=chat,
        direct_recipient_digest=digest,
        idempotency_key=idempotency_key,
        status="reserved",
    )
    db.add(job)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise ConsentLedgerError("Invitation already attempted or reserved") from exc
    await db.refresh(job)
    return job


async def finish_direct_invite(
    db: AsyncSession,
    *,
    owner_id: str,
    job_id: str,
    outcome: str,
) -> TelegramInviteJob:
    """Persist a Telegram-confirmed outcome; never replay network requests."""
    if outcome not in {"invited", "declined", "unknown"}:
        raise ConsentLedgerError("Invalid direct invite outcome")
    job = (
        await db.execute(
            select(TelegramInviteJob).where(
                TelegramInviteJob.id == _uuid(job_id),
                TelegramInviteJob.owner_id == _uuid(owner_id),
                TelegramInviteJob.direct_recipient_digest.is_not(None),
            ).with_for_update()
        )
    ).scalar_one_or_none()
    if job is None or job.status != "reserved":
        raise ConsentLedgerError("Direct invite is missing, cancelled or already finalized")
    job.status = outcome
    await db.commit()
    await db.refresh(job)
    return job
