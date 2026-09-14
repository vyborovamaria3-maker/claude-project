from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class KOLProfile(Base):
    __tablename__ = "kol_profiles"
    __table_args__ = (
        UniqueConstraint("twitter_handle", name="uq_kol_profiles_twitter_handle"),
        Index("ix_kol_profiles_confidence", "confidence"),
        Index("ix_kol_profiles_verified_updated", "verified", "updated_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    twitter_handle: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    twitter_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    telegram_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    source_meta: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    wallets: Mapped[list[KOLWalletAttribution]] = relationship(
        back_populates="profile",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class KOLWalletAttribution(Base):
    __tablename__ = "kol_wallet_attributions"
    __table_args__ = (
        UniqueConstraint("kol_id", "chain", "address", name="uq_kol_wallet_attribution"),
        Index("ix_kol_wallet_address_chain", "address", "chain"),
        Index("ix_kol_wallet_verified_confidence", "verified", "confidence"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kol_id: Mapped[int] = mapped_column(ForeignKey("kol_profiles.id", ondelete="CASCADE"), nullable=False, index=True)
    analytics_wallet_id: Mapped[int | None] = mapped_column(ForeignKey("wallets.id", ondelete="SET NULL"), nullable=True, index=True)
    address: Mapped[str] = mapped_column(String(128), nullable=False)
    chain: Mapped[str] = mapped_column(String(32), nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    source_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    profile: Mapped[KOLProfile] = relationship(back_populates="wallets")
    evidence: Mapped[list[KOLWalletEvidence]] = relationship(
        back_populates="wallet",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    metrics: Mapped[list[KOLWalletMetric]] = relationship(
        back_populates="wallet",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class KOLWalletEvidence(Base):
    __tablename__ = "kol_wallet_evidence"
    __table_args__ = (
        UniqueConstraint("wallet_id", "source", "kind", "fingerprint", name="uq_kol_wallet_evidence_fingerprint"),
        Index("ix_kol_wallet_evidence_source_observed", "source", "observed_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    wallet_id: Mapped[int] = mapped_column(ForeignKey("kol_wallet_attributions.id", ondelete="CASCADE"), nullable=False, index=True)
    source: Mapped[str] = mapped_column(String(120), nullable=False)
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    detail: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    source_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    raw_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    wallet: Mapped[KOLWalletAttribution] = relationship(back_populates="evidence")


class KOLWalletMetric(Base):
    __tablename__ = "kol_wallet_metrics"
    __table_args__ = (
        UniqueConstraint("wallet_id", "timeframe_days", "source", name="uq_kol_wallet_metric_window_source"),
        Index("ix_kol_wallet_metrics_window_calculated", "timeframe_days", "calculated_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    wallet_id: Mapped[int] = mapped_column(ForeignKey("kol_wallet_attributions.id", ondelete="CASCADE"), nullable=False, index=True)
    timeframe_days: Mapped[int] = mapped_column(Integer, nullable=False)
    source: Mapped[str] = mapped_column(String(120), nullable=False, default="internal")
    pnl_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    pnl_currency: Mapped[str | None] = mapped_column(String(16), nullable=True)
    realized_pnl_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    unrealized_pnl_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    win_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    wins: Mapped[int | None] = mapped_column(Integer, nullable=True)
    losses: Mapped[int | None] = mapped_column(Integer, nullable=True)
    volume_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    trade_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_trade_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    raw_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    calculated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    wallet: Mapped[KOLWalletAttribution] = relationship(back_populates="metrics")


class KOLSourceSync(Base):
    __tablename__ = "kol_source_syncs"
    __table_args__ = (UniqueConstraint("source", name="uq_kol_source_sync_source"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="unknown")
    records_seen: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    detail: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
