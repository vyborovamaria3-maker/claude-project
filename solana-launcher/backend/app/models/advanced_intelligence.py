from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class CampaignFingerprint(Base):
    __tablename__ = "campaign_fingerprints"
    __table_args__ = (
        UniqueConstraint(
            "snapshot_id",
            name="uq_campaign_fingerprints_snapshot",
        ),
        Index(
            "ix_campaign_fingerprints_mint_created",
            "mint_address",
            "created_at",
        ),
        Index("ix_campaign_fingerprints_hash", "fingerprint_hash"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[str] = mapped_column(String(160), nullable=False)
    mint_address: Mapped[str] = mapped_column(String(64), nullable=False)
    fingerprint_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    vector: Mapped[dict] = mapped_column(JSON, nullable=False)
    actors: Mapped[list | None] = mapped_column(JSON, nullable=True)
    narratives: Mapped[list | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        nullable=False,
    )


class CampaignFingerprintFeature(Base):
    """Compact numeric campaign vector used by exact SQL similarity search."""

    __tablename__ = "campaign_fingerprint_features"
    __table_args__ = (
        Index(
            "ix_campaign_fingerprint_features_schema_created",
            "schema_version",
            "created_at",
        ),
        Index(
            "ix_campaign_fingerprint_features_mint_created",
            "mint_address",
            "created_at",
        ),
    )

    snapshot_id: Mapped[str] = mapped_column(
        ForeignKey("campaign_fingerprints.snapshot_id", ondelete="CASCADE"),
        primary_key=True,
    )
    mint_address: Mapped[str] = mapped_column(String(64), nullable=False)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    x_accounts: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    tg_channels: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    wallets: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    bundles: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    shared_links: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    copies: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    amplifies: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    mentions_wallet: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    social_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    x_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    telegram_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    organic: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    manipulation: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    early: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    alpha: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    bot_risk: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    vector_norm: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    actor_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class CampaignFingerprintActor(Base):
    """Normalized actor membership for exact campaign Jaccard similarity."""

    __tablename__ = "campaign_fingerprint_actors"
    __table_args__ = (
        UniqueConstraint(
            "snapshot_id",
            "actor_key",
            name="uq_campaign_fingerprint_actor",
        ),
        Index(
            "ix_campaign_fingerprint_actors_actor_snapshot",
            "actor_key",
            "snapshot_id",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[str] = mapped_column(
        ForeignKey("campaign_fingerprint_features.snapshot_id", ondelete="CASCADE"),
        nullable=False,
    )
    actor_key: Mapped[str] = mapped_column(String(160), nullable=False)


class IntelligenceHypothesisState(Base):
    __tablename__ = "intelligence_hypothesis_states"
    __table_args__ = (
        UniqueConstraint(
            "hypothesis_key",
            name="uq_intelligence_hypothesis_key",
        ),
        Index(
            "ix_intelligence_hypothesis_status_updated",
            "status",
            "updated_at",
        ),
        Index(
            "ix_intelligence_hypothesis_mint",
            "mint_address",
            "updated_at",
        ),
        Index(
            "ix_intelligence_hypothesis_source_updated",
            "source_key",
            "updated_at",
        ),
        Index(
            "ix_intelligence_hypothesis_target_updated",
            "target_key",
            "updated_at",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    hypothesis_key: Mapped[str] = mapped_column(String(256), nullable=False)
    mint_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    hypothesis_type: Mapped[str] = mapped_column(String(120), nullable=False)
    source_key: Mapped[str | None] = mapped_column(String(160), nullable=True)
    target_key: Mapped[str | None] = mapped_column(String(160), nullable=True)
    status: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default="hypothesis",
    )
    confidence: Mapped[float] = mapped_column(
        Float,
        nullable=False,
        default=0.0,
    )
    support_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
    )
    contradiction_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
    )
    evidence: Mapped[list | None] = mapped_column(JSON, nullable=True)
    observations: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        nullable=False,
    )


class IntelligenceOutcome(Base):
    __tablename__ = "intelligence_outcomes"
    __table_args__ = (
        UniqueConstraint(
            "snapshot_id",
            "horizon_hours",
            name="uq_intelligence_outcome_snapshot_horizon",
        ),
        Index(
            "ix_intelligence_outcomes_mint_horizon",
            "mint_address",
            "horizon_hours",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[str] = mapped_column(String(160), nullable=False)
    mint_address: Mapped[str] = mapped_column(String(64), nullable=False)
    horizon_hours: Mapped[int] = mapped_column(Integer, nullable=False)
    baseline_price_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_price_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    min_price_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    final_price_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_multiple: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_drawdown_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    outcome_label: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        default="unknown",
    )
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    evaluated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        nullable=False,
    )


class IntelligenceEntityOutcomeProjection(Base):
    """Prepared earliest-snapshot outcome per entity/token/horizon.

    Advanced-analysis reads this projection instead of rebuilding the
    entity -> earliest snapshot -> outcome join on every report.
    """

    __tablename__ = "intelligence_entity_outcomes"
    __table_args__ = (
        UniqueConstraint(
            "entity_key",
            "mint_address",
            "horizon_hours",
            name="uq_intelligence_entity_outcome",
        ),
        Index(
            "ix_intelligence_entity_outcomes_entity_horizon",
            "entity_key",
            "horizon_hours",
        ),
        Index(
            "ix_intelligence_entity_outcomes_horizon_mint",
            "horizon_hours",
            "mint_address",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity_key: Mapped[str] = mapped_column(String(160), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    mint_address: Mapped[str] = mapped_column(String(64), nullable=False)
    horizon_hours: Mapped[int] = mapped_column(Integer, nullable=False)
    snapshot_id: Mapped[str] = mapped_column(String(160), nullable=False)
    max_multiple: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_drawdown_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    outcome_label: Mapped[str] = mapped_column(String(64), nullable=False)
    evaluated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        nullable=False,
    )


class IntelligenceCalibrationStat(Base):
    __tablename__ = "intelligence_calibration_stats"
    __table_args__ = (
        UniqueConstraint(
            "model_version",
            "signal_type",
            "bucket",
            name="uq_intelligence_calibration_bucket",
        ),
        Index(
            "ix_intelligence_calibration_signal",
            "signal_type",
            "updated_at",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    model_version: Mapped[str] = mapped_column(String(120), nullable=False)
    signal_type: Mapped[str] = mapped_column(String(120), nullable=False)
    bucket: Mapped[str] = mapped_column(String(32), nullable=False)
    sample_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
    )
    predicted_confidence_sum: Mapped[float] = mapped_column(
        Float,
        nullable=False,
        default=0.0,
    )
    confirmed_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
    )
    contradicted_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        nullable=False,
    )


class IntelligenceNarrativeMemory(Base):
    __tablename__ = "intelligence_narrative_memory"
    __table_args__ = (
        UniqueConstraint(
            "narrative_key",
            name="uq_intelligence_narrative_key",
        ),
        Index("ix_intelligence_narrative_last", "last_seen_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    narrative_key: Mapped[str] = mapped_column(String(160), nullable=False)
    label: Mapped[str] = mapped_column(String(500), nullable=False)
    occurrence_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=1,
    )
    token_mints: Mapped[list | None] = mapped_column(JSON, nullable=True)
    actor_keys: Mapped[list | None] = mapped_column(JSON, nullable=True)
    examples: Mapped[list | None] = mapped_column(JSON, nullable=True)
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        nullable=False,
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        nullable=False,
    )
