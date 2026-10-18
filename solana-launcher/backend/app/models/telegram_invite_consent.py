"""Durable, owner-scoped Telegram opt-in proofs and non-dispatchable jobs.

These records cannot authorize an invitation by themselves. A future Telegram
webhook verifier must authenticate and validate the event before recording
consent. No API accepts client-supplied consent booleans or proofs.
"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class TelegramInviteConsent(Base):
    __tablename__ = "telegram_invite_consents"
    __table_args__ = (
        UniqueConstraint("proof_digest", name="uq_tginvite_consent_proof_digest"),
        CheckConstraint(
            "proof_kind IN ('telegram_bot_start', 'telegram_chat_join_request')",
            name="ck_tginvite_consent_proof_kind",
        ),
    )

    id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    owner_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    destination_chat_id: Mapped[str] = mapped_column(String(128), nullable=False)
    # Keyed, per-deployment HMAC of a canonical Telegram user ID. No plaintext ID.
    recipient_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    proof_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    proof_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    verified_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TelegramInviteJob(Base):
    __tablename__ = "telegram_invite_jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('blocked_transport', 'cancelled', 'reserved', "
            "'invited', 'declined', 'unknown')",
            name="ck_tginvite_job_status_no_dispatch",
        ),
        UniqueConstraint(
            "owner_id", "idempotency_key", name="uq_tginvite_job_owner_request",
        ),
        UniqueConstraint(
            "owner_id", "destination_chat_id", "direct_recipient_digest",
            name="uq_tginvite_direct_once_per_recipient",
        ),
        CheckConstraint(
            "(status NOT IN ('reserved', 'invited', 'declined', 'unknown')) "
            "OR direct_recipient_digest IS NOT NULL",
            name="ck_tginvite_direct_requires_digest",
        ),

    )

    id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    owner_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    consent_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("telegram_invite_consents.id", ondelete="RESTRICT"),
        nullable=False,
    )
    destination_chat_id: Mapped[str] = mapped_column(String(128), nullable=False)
    # Only HMAC of Telegram recipient ID; never store raw IDs or access hashes.
    direct_recipient_digest: Mapped[str | None] = mapped_column(String(64), nullable=True)
    idempotency_key: Mapped[str] = mapped_column(String(96), nullable=False)
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="blocked_transport",
        server_default="blocked_transport",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
