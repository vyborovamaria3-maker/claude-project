"""Encrypted session metadata. No Telegram credentials are stored as plaintext."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class TelegramInviteSession(Base):
    __tablename__ = "telegram_invite_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("users.id", ondelete="CASCADE"),
        unique=True,
        index=True,
        nullable=False,
    )
    # Null is a revocation tombstone, not an absent owner row.
    encrypted_payload: Mapped[str | None] = mapped_column(Text, nullable=True)
    generation: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )
