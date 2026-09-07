from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from typing import Any

from sqlalchemy import (
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
    and_,
    case,
    event,
    func,
    or_,
    select,
    update,
)
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
    status: Mapped[str] = mapped_column(
        String(16),
        default=TokenStatus.ACTIVE.value,
        nullable=False,
    )
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
    token_id: Mapped[int] = mapped_column(
        ForeignKey("tokens.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
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


class TokenLatestMetric(Base):
    """One hot row per token for dashboard sorting and list rendering."""

    __tablename__ = "token_latest_metrics"
    __table_args__ = (
        Index("ix_token_latest_metrics_ath_usd", "ath_usd"),
        Index("ix_token_latest_metrics_volume_24h", "volume_24h"),
        Index("ix_token_latest_metrics_liquidity_usd", "liquidity_usd"),
        Index("ix_token_latest_metrics_market_cap", "market_cap"),
        Index("ix_token_latest_metrics_holder_count", "holder_count"),
    )

    token_id: Mapped[int] = mapped_column(
        ForeignKey("tokens.id", ondelete="CASCADE"),
        primary_key=True,
    )
    metric_id: Mapped[int] = mapped_column(Integer, nullable=False, unique=True, index=True)
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


def _latest_metric_values(metric: TokenMetric) -> dict[str, Any]:
    return {
        "token_id": metric.token_id,
        "metric_id": metric.id,
        "timestamp": metric.timestamp,
        "price_usd": metric.price_usd,
        "ath_usd": metric.ath_usd,
        "ath_date": metric.ath_date,
        "market_cap": metric.market_cap,
        "fdv": metric.fdv,
        "liquidity_usd": metric.liquidity_usd,
        "volume_24h": metric.volume_24h,
        "tx_count_24h": metric.tx_count_24h,
        "holder_count": metric.holder_count,
        "twitter_url": metric.twitter_url,
        "telegram_url": metric.telegram_url,
        "discord_url": metric.discord_url,
        "website_url": metric.website_url,
        "social_engagements": metric.social_engagements,
    }


def _upsert_latest_metric(connection: Any, metric: TokenMetric) -> None:
    values = _latest_metric_values(metric)
    dialect_name = connection.dialect.name

    statement: Any
    if dialect_name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as pg_insert

        statement = pg_insert(TokenLatestMetric).values(**values)
    elif dialect_name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as sqlite_insert

        statement = sqlite_insert(TokenLatestMetric).values(**values)
    else:
        current = connection.execute(
            select(TokenLatestMetric.timestamp, TokenLatestMetric.metric_id).where(
                TokenLatestMetric.token_id == metric.token_id
            )
        ).first()
        if current is None:
            connection.execute(TokenLatestMetric.__table__.insert().values(**values))
            return

        current_timestamp, current_metric_id = current
        if metric.timestamp > current_timestamp or (
            metric.timestamp == current_timestamp and metric.id > current_metric_id
        ):
            connection.execute(
                update(TokenLatestMetric)
                .where(TokenLatestMetric.token_id == metric.token_id)
                .values(
                    **{
                        key: value
                        for key, value in values.items()
                        if key != "token_id"
                    }
                )
            )
        return

    excluded = statement.excluded
    newer = or_(
        excluded.timestamp > TokenLatestMetric.timestamp,
        and_(
            excluded.timestamp == TokenLatestMetric.timestamp,
            excluded.metric_id > TokenLatestMetric.metric_id,
        ),
    )
    ath_improved = and_(
        excluded.ath_usd.is_not(None),
        or_(
            TokenLatestMetric.ath_usd.is_(None),
            excluded.ath_usd > TokenLatestMetric.ath_usd,
        ),
    )
    last_known_fields = (
        "price_usd",
        "market_cap",
        "fdv",
        "liquidity_usd",
        "volume_24h",
        "tx_count_24h",
        "holder_count",
        "twitter_url",
        "telegram_url",
        "discord_url",
        "website_url",
        "social_engagements",
    )
    update_values: dict[str, Any] = {
        "metric_id": excluded.metric_id,
        "timestamp": excluded.timestamp,
        "ath_usd": case(
            (ath_improved, excluded.ath_usd),
            else_=TokenLatestMetric.ath_usd,
        ),
        "ath_date": case(
            (
                ath_improved,
                func.coalesce(excluded.ath_date, excluded.timestamp),
            ),
            else_=TokenLatestMetric.ath_date,
        ),
    }
    update_values.update(
        {
            key: func.coalesce(
                getattr(excluded, key),
                getattr(TokenLatestMetric, key),
            )
            for key in last_known_fields
        }
    )
    connection.execute(
        statement.on_conflict_do_update(
            index_elements=[TokenLatestMetric.token_id],
            set_=update_values,
            where=newer,
        )
    )


@event.listens_for(TokenMetric, "after_insert")
def _sync_token_latest_metric(_mapper: Any, connection: Any, target: TokenMetric) -> None:
    _upsert_latest_metric(connection, target)


class Wallet(Base):
    __tablename__ = "wallets"
    __table_args__ = (UniqueConstraint("wallet_address", name="uq_wallets_wallet_address"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    wallet_address: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        unique=True,
        index=True,
    )
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
        Index("ix_wallet_trades_wallet_buy_timestamp", "wallet_id", "buy_timestamp"),
        Index("ix_wallet_trades_profit", "realized_profit_usd"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    wallet_id: Mapped[int] = mapped_column(
        ForeignKey("wallets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    token_id: Mapped[int] = mapped_column(
        ForeignKey("tokens.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    buy_timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    sell_timestamp: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        index=True,
    )
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
    wallet_a_id: Mapped[int] = mapped_column(
        ForeignKey("wallets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    wallet_b_id: Mapped[int] = mapped_column(
        ForeignKey("wallets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    shared_tokens_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    first_interaction_date: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
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
