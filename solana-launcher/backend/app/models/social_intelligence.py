from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class TelegramChannel(Base):
    __tablename__ = "telegram_channels"
    __table_args__ = (
        UniqueConstraint("telegram_id", name="uq_telegram_channels_telegram_id"),
        Index("ix_telegram_channels_username", "username"),
        Index("ix_telegram_channels_participants", "participants"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger, nullable=False, unique=True)
    username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(24), nullable=False, default="channel")
    participants: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    about: Mapped[str] = mapped_column(Text, nullable=False, default="")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    last_scanned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    meta: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class TelegramUser(Base):
    __tablename__ = "telegram_users"
    __table_args__ = (
        UniqueConstraint("telegram_id", name="uq_telegram_users_telegram_id"),
        Index("ix_telegram_users_username", "username"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger, nullable=False, unique=True)
    username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    meta: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class TelegramMessage(Base):
    __tablename__ = "telegram_messages"
    __table_args__ = (
        UniqueConstraint("channel_id", "telegram_message_id", name="uq_telegram_messages_channel_message"),
        Index("ix_telegram_messages_channel_date", "channel_id", "published_at"),
        Index("ix_telegram_messages_sender", "sender_telegram_id", "published_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    channel_id: Mapped[int] = mapped_column(ForeignKey("telegram_channels.id", ondelete="CASCADE"), nullable=False)
    telegram_message_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sender_id: Mapped[int | None] = mapped_column(ForeignKey("telegram_users.id", ondelete="SET NULL"), nullable=True)
    sender_telegram_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    sender_username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sender_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    views: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    forwards: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    replies: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    reactions: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    raw: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class TelegramTokenMention(Base):
    __tablename__ = "telegram_token_mentions"
    __table_args__ = (
        UniqueConstraint("message_id", "mint_address", name="uq_telegram_token_mentions_message_mint"),
        Index("ix_telegram_token_mentions_mint_date", "mint_address", "first_seen_at"),
        Index("ix_telegram_token_mentions_channel", "channel_id", "first_seen_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    message_id: Mapped[int] = mapped_column(ForeignKey("telegram_messages.id", ondelete="CASCADE"), nullable=False)
    channel_id: Mapped[int] = mapped_column(ForeignKey("telegram_channels.id", ondelete="CASCADE"), nullable=False)
    mint_address: Mapped[str] = mapped_column(String(64), nullable=False)
    ticker: Mapped[str | None] = mapped_column(String(32), nullable=True)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    source_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    is_explicit_call: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class TelegramCall(Base):
    __tablename__ = "telegram_calls"
    __table_args__ = (
        UniqueConstraint("mention_id", name="uq_telegram_calls_mention"),
        Index("ix_telegram_calls_mint_called", "mint_address", "called_at"),
        Index("ix_telegram_calls_channel_called", "channel_id", "called_at"),
        Index("ix_telegram_calls_caller", "caller_username", "called_at"),
        Index("ix_telegram_calls_outcome", "outcome"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    mention_id: Mapped[int] = mapped_column(ForeignKey("telegram_token_mentions.id", ondelete="CASCADE"), nullable=False, unique=True)
    channel_id: Mapped[int] = mapped_column(ForeignKey("telegram_channels.id", ondelete="CASCADE"), nullable=False)
    message_id: Mapped[int] = mapped_column(ForeignKey("telegram_messages.id", ondelete="CASCADE"), nullable=False)
    mint_address: Mapped[str] = mapped_column(String(64), nullable=False)
    caller_telegram_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    caller_username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    called_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    is_explicit_call: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    call_price_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    call_market_cap_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    peak_price_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    peak_market_cap_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    roi_multiple: Mapped[float | None] = mapped_column(Float, nullable=True)
    outcome: Mapped[str] = mapped_column(String(24), nullable=False, default="pending")
    evaluated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    meta: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class TelegramChannelScore(Base):
    __tablename__ = "telegram_channel_scores"

    channel_id: Mapped[int] = mapped_column(ForeignKey("telegram_channels.id", ondelete="CASCADE"), primary_key=True)
    calls_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    evaluated_calls: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    successful_calls: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rug_calls: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    early_calls: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    win_rate: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    rug_rate: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    avg_roi: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class SocialRelation(Base):
    __tablename__ = "social_relations"
    __table_args__ = (
        UniqueConstraint(
            "source_platform",
            "source_handle",
            "target_platform",
            "target_handle",
            "relation_type",
            name="uq_social_relations_edge",
        ),
        Index("ix_social_relations_source", "source_platform", "source_handle"),
        Index("ix_social_relations_target", "target_platform", "target_handle"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_platform: Mapped[str] = mapped_column(String(24), nullable=False)
    source_handle: Mapped[str] = mapped_column(String(128), nullable=False)
    target_platform: Mapped[str] = mapped_column(String(24), nullable=False)
    target_handle: Mapped[str] = mapped_column(String(128), nullable=False)
    relation_type: Mapped[str] = mapped_column(String(32), nullable=False, default="mention")
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    evidence: Mapped[str] = mapped_column(Text, nullable=False, default="")


class SocialEvent(Base):
    __tablename__ = "social_events"
    __table_args__ = (
        UniqueConstraint("platform", "event_type", "external_id", "mint_address", name="uq_social_events_external_mint"),
        Index("ix_social_events_mint_time", "mint_address", "occurred_at"),
        Index("ix_social_events_platform_time", "platform", "occurred_at"),
        Index("ix_social_events_source", "source_handle", "occurred_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    platform: Mapped[str] = mapped_column(String(24), nullable=False)
    event_type: Mapped[str] = mapped_column(String(32), nullable=False, default="token_mention")
    external_id: Mapped[str] = mapped_column(String(128), nullable=False)
    source_handle: Mapped[str | None] = mapped_column(String(128), nullable=True)
    source_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    mint_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    symbol: Mapped[str | None] = mapped_column(String(32), nullable=True)
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    metrics: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
