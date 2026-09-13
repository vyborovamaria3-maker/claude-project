from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class TwitterDiscoveryRun(Base):
    __tablename__ = "twitter_discovery_runs"
    __table_args__ = (
        Index("ix_twitter_discovery_runs_started_at", "started_at"),
        Index("ix_twitter_discovery_runs_status", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="running")
    worker_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    mode: Mapped[str] = mapped_column(String(32), nullable=False, default="public_no_x_api")
    trigger: Mapped[str] = mapped_column(String(32), nullable=False, default="manual")
    config_snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    candidates_created: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    evidence_created: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rescored: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    promoted: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    skipped: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class TwitterDiscoveryRunLock(Base):
    __tablename__ = "twitter_discovery_run_locks"
    __table_args__ = (
        Index("ix_twitter_discovery_run_locks_lease", "lease_expires_at"),
    )

    lock_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_token: Mapped[str] = mapped_column(String(64), nullable=False)
    run_id: Mapped[int | None] = mapped_column(
        ForeignKey("twitter_discovery_runs.id", ondelete="SET NULL"), nullable=True
    )
    lease_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class TwitterDiscoveryConfig(Base):
    __tablename__ = "twitter_discovery_config"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    discovery_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    dexscreener_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    coinmarketcap_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    seed_discovery_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    public_web_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    x_api_enrichment_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    cmc_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=50)
    rescore_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=1000)
    process_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=250)
    network_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    max_depth: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    min_relevance: Mapped[float] = mapped_column(Float, nullable=False, default=35.0)
    batch_size: Mapped[int] = mapped_column(Integer, nullable=False, default=25)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_by: Mapped[str | None] = mapped_column(String(128), nullable=True)
