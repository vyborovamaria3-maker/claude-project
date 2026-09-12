from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class TwitterAccount(Base):
    __tablename__ = "twitter_accounts"
    __table_args__ = (
        UniqueConstraint("twitter_id", name="uq_twitter_accounts_twitter_id"),
        Index("ix_twitter_accounts_username", "username"),
        Index("ix_twitter_accounts_type_status", "account_type", "status"),
        Index("ix_twitter_accounts_last_seen", "last_seen_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    twitter_id: Mapped[str] = mapped_column(String(32), nullable=False)
    username: Mapped[str | None] = mapped_column(String(64), nullable=True)
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    bio: Mapped[str] = mapped_column(Text, nullable=False, default="")
    avatar_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    followers_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    following_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    tweet_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    x_created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    account_type: Mapped[str] = mapped_column(String(32), nullable=False, default="unknown")
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="active")
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    last_profile_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    source: Mapped[str] = mapped_column(String(64), nullable=False, default="unknown")
    raw: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class TwitterAccountSnapshot(Base):
    __tablename__ = "twitter_account_snapshots"
    __table_args__ = (
        Index("ix_twitter_account_snapshots_account_time", "account_id", "captured_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(
        ForeignKey("twitter_accounts.id", ondelete="CASCADE"), nullable=False
    )
    followers_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    following_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    tweet_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    source: Mapped[str] = mapped_column(String(64), nullable=False, default="unknown")
    raw: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class TwitterAccountScore(Base):
    __tablename__ = "twitter_account_scores"
    __table_args__ = (Index("ix_twitter_account_scores_alpha", "alpha_score"),)

    account_id: Mapped[int] = mapped_column(
        ForeignKey("twitter_accounts.id", ondelete="CASCADE"), primary_key=True
    )
    influence_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    trust_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    alpha_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    shill_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    bot_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    crypto_relevance_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    solana_relevance_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    score_confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    score_source: Mapped[str] = mapped_column(String(64), nullable=False, default="unknown")
    model_version: Mapped[str | None] = mapped_column(String(128), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    meta: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class TwitterPost(Base):
    __tablename__ = "twitter_posts"
    __table_args__ = (
        UniqueConstraint("twitter_post_id", name="uq_twitter_posts_twitter_post_id"),
        Index("ix_twitter_posts_account_published", "account_id", "published_at"),
        Index("ix_twitter_posts_published", "published_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    twitter_post_id: Mapped[str] = mapped_column(String(32), nullable=False)
    account_id: Mapped[int] = mapped_column(
        ForeignKey("twitter_accounts.id", ondelete="CASCADE"), nullable=False
    )
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    likes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    replies: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    reposts: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    quotes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    views: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    language: Mapped[str | None] = mapped_column(String(16), nullable=True)
    sentiment: Mapped[float | None] = mapped_column(Float, nullable=True)
    crypto_relevance: Mapped[float | None] = mapped_column(Float, nullable=True)
    spam_probability: Mapped[float | None] = mapped_column(Float, nullable=True)
    source_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    source: Mapped[str] = mapped_column(String(64), nullable=False, default="unknown")
    raw: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)


class TwitterPostToken(Base):
    __tablename__ = "twitter_post_tokens"
    __table_args__ = (
        UniqueConstraint("post_id", "mint_address", name="uq_twitter_post_tokens_post_mint"),
        Index("ix_twitter_post_tokens_mint_time", "mint_address", "first_seen_at"),
        Index("ix_twitter_post_tokens_account_time", "account_id", "first_seen_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    post_id: Mapped[int] = mapped_column(
        ForeignKey("twitter_posts.id", ondelete="CASCADE"), nullable=False
    )
    account_id: Mapped[int] = mapped_column(
        ForeignKey("twitter_accounts.id", ondelete="CASCADE"), nullable=False
    )
    mint_address: Mapped[str] = mapped_column(String(64), nullable=False)
    symbol: Mapped[str | None] = mapped_column(String(32), nullable=True)
    mention_type: Mapped[str] = mapped_column(String(24), nullable=False, default="mention")
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    meta: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class TwitterAccountTokenStat(Base):
    __tablename__ = "twitter_account_token_stats"
    __table_args__ = (
        UniqueConstraint("account_id", "mint_address", name="uq_twitter_account_token_stats_account_mint"),
        Index("ix_twitter_account_token_stats_mint_alpha", "mint_address", "token_alpha_score"),
        Index("ix_twitter_account_token_stats_account_updated", "account_id", "updated_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(
        ForeignKey("twitter_accounts.id", ondelete="CASCADE"), nullable=False
    )
    mint_address: Mapped[str] = mapped_column(String(64), nullable=False)
    mentions_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    bullish_mentions: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    bearish_mentions: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    neutral_mentions: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    first_mention_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_mention_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    price_at_first_mention: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_price_after_mention: Mapped[float | None] = mapped_column(Float, nullable=True)
    min_price_after_mention: Mapped[float | None] = mapped_column(Float, nullable=True)
    avg_return_1h: Mapped[float | None] = mapped_column(Float, nullable=True)
    avg_return_6h: Mapped[float | None] = mapped_column(Float, nullable=True)
    avg_return_24h: Mapped[float | None] = mapped_column(Float, nullable=True)
    avg_return_7d: Mapped[float | None] = mapped_column(Float, nullable=True)
    successful_calls: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_calls: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    token_alpha_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=utcnow)
    meta: Mapped[dict | None] = mapped_column(JSON, nullable=True)
