from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class TokenStatus(StrEnum):
    ACTIVE = "active"
    MIGRATED = "migrated"
    RUGGED = "rugged"


class Token(Base):
    __tablename__ = "tokens"
    __table_args__ = (
        UniqueConstraint("mint_address", name="uq_tokens_mint_address"),
        Index("ix_tokens_status_migration_date", "status", "migration_date"),
        Index("ix_tokens_creator_wallet", "creator_wallet"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    mint_address: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    symbol: Mapped[str | None] = mapped_column(String(64), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    creator_wallet: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    creation_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    migrated_to_raydium: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    migration_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default=TokenStatus.ACTIVE.value, nullable=False)
    last_synced_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    metrics: Mapped[list[TokenMetric]] = relationship(
        back_populates="token",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    trades: Mapped[list[WalletTrade]] = relationship(back_populates="token", lazy="selectin")


class TokenMetric(Base):
    __tablename__ = "token_metrics"
    __table_args__ = (
        Index("ix_token_metrics_token_timestamp", "token_id", "timestamp"),
        Index("ix_token_metrics_ath_usd", "ath_usd"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    token_id: Mapped[int] = mapped_column(ForeignKey("tokens.id", ondelete="CASCADE"), nullable=False, index=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    price_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    ath_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    ath_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    market_cap: Mapped[float | None] = mapped_column(Float, nullable=True)
    fdv: Mapped[float | None] = mapped_column(Float, nullable=True)
    liquidity_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    volume_24h: Mapped[float | None] = mapped_column(Float, nullable=True)
    tx_count_24h: Mapped[int | None] = mapped_column(Integer, nullable=True)
    holder_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    twitter_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    telegram_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    discord_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    website_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    social_engagements: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    token: Mapped[Token] = relationship(back_populates="metrics")


class Wallet(Base):
    __tablename__ = "wallets"
    __table_args__ = (UniqueConstraint("wallet_address", name="uq_wallets_wallet_address"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    wallet_address: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    first_seen_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    tags: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    trades: Mapped[list[WalletTrade]] = relationship(back_populates="wallet", lazy="selectin")


class WalletTrade(Base):
    __tablename__ = "wallet_trades"
    __table_args__ = (
        Index("ix_wallet_trades_wallet_token", "wallet_id", "token_id"),
        Index("ix_wallet_trades_profit", "realized_profit_usd"),
        Index("ix_wallet_trades_buy_timestamp", "buy_timestamp"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    wallet_id: Mapped[int] = mapped_column(ForeignKey("wallets.id", ondelete="CASCADE"), nullable=False, index=True)
    token_id: Mapped[int] = mapped_column(ForeignKey("tokens.id", ondelete="CASCADE"), nullable=False, index=True)
    buy_timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    sell_timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    amount_buy: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    amount_sold: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    avg_buy_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    avg_sell_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    realized_profit_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    still_holding: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    wallet: Mapped[Wallet] = relationship(back_populates="trades")
    token: Mapped[Token] = relationship(back_populates="trades")


class WalletLink(Base):
    __tablename__ = "wallet_links"
    __table_args__ = (
        UniqueConstraint("wallet_a_id", "wallet_b_id", name="uq_wallet_links_pair"),
        Index("ix_wallet_links_shared_tokens_count", "shared_tokens_count"),
        Index("ix_wallet_links_similarity_score", "similarity_score"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    wallet_a_id: Mapped[int] = mapped_column(ForeignKey("wallets.id", ondelete="CASCADE"), nullable=False, index=True)
    wallet_b_id: Mapped[int] = mapped_column(ForeignKey("wallets.id", ondelete="CASCADE"), nullable=False, index=True)
    shared_tokens_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    first_interaction_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    similarity_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    details: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


class CollectorJob(Base):
    __tablename__ = "collector_jobs"
    __table_args__ = (UniqueConstraint("job_name", name="uq_collector_jobs_job_name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    job_name: Mapped[str] = mapped_column(String(128), nullable=False, unique=True, index=True)
    last_run: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    meta: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
