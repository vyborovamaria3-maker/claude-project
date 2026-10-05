from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class IntelligenceSnapshot(Base):
    __tablename__ = "intelligence_snapshots"
    __table_args__ = (
        Index("ix_intelligence_snapshots_mint_created", "mint_address", "created_at"),
        Index("ix_intelligence_snapshots_created", "created_at"),
    )

    snapshot_id: Mapped[str] = mapped_column(String(160), primary_key=True)
    mint_address: Mapped[str] = mapped_column(String(64), nullable=False)
    symbol: Mapped[str | None] = mapped_column(String(32), nullable=True)
    token_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    snapshot_version: Mapped[str] = mapped_column(String(80), nullable=False)
    graph_version: Mapped[str] = mapped_column(String(80), nullable=False)
    feature_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    missing_feature_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    model: Mapped[str | None] = mapped_column(String(160), nullable=True)
    provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    prompt_version: Mapped[str | None] = mapped_column(String(80), nullable=True)
    overall_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False)
    analysis_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    ai_result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class IntelligenceEntity(Base):
    __tablename__ = "intelligence_entities"
    __table_args__ = (
        UniqueConstraint("entity_key", name="uq_intelligence_entities_key"),
        Index("ix_intelligence_entities_type_last", "entity_type", "last_seen_at"),
        Index("ix_intelligence_entities_label", "label"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity_key: Mapped[str] = mapped_column(String(160), nullable=False, unique=True)
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    label: Mapped[str] = mapped_column(String(1000), nullable=False)
    # Number of distinct token mints where this entity was observed.
    occurrence_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    attributes: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class IntelligenceSnapshotEntity(Base):
    __tablename__ = "intelligence_snapshot_entities"
    __table_args__ = (
        UniqueConstraint(
            "snapshot_id",
            "entity_key",
            name="uq_intelligence_snapshot_entity",
        ),
        Index(
            "ix_intelligence_snapshot_entities_entity",
            "entity_key",
            "snapshot_id",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[str] = mapped_column(
        ForeignKey("intelligence_snapshots.snapshot_id", ondelete="CASCADE"),
        nullable=False,
    )
    entity_key: Mapped[str] = mapped_column(String(160), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    label: Mapped[str] = mapped_column(String(1000), nullable=False)
    attributes: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class IntelligenceEdge(Base):
    __tablename__ = "intelligence_edges"
    __table_args__ = (
        UniqueConstraint(
            "source_key",
            "target_key",
            "edge_type",
            name="uq_intelligence_edges_triplet",
        ),
        Index("ix_intelligence_edges_source", "source_key", "last_seen_at"),
        Index("ix_intelligence_edges_target", "target_key", "last_seen_at"),
        Index("ix_intelligence_edges_type", "edge_type", "last_seen_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_key: Mapped[str] = mapped_column(String(160), nullable=False)
    target_key: Mapped[str] = mapped_column(String(160), nullable=False)
    edge_type: Mapped[str] = mapped_column(String(64), nullable=False)
    # Number of distinct token mints where this relationship was observed.
    occurrence_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    confidence_sum: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    max_confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    last_snapshot_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    evidence: Mapped[list | None] = mapped_column(JSON, nullable=True)
    attributes: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class IntelligenceSnapshotEdge(Base):
    __tablename__ = "intelligence_snapshot_edges"
    __table_args__ = (
        UniqueConstraint(
            "snapshot_id",
            "source_key",
            "target_key",
            "edge_type",
            name="uq_intelligence_snapshot_edge",
        ),
        Index(
            "ix_intelligence_snapshot_edges_source",
            "source_key",
            "snapshot_id",
        ),
        Index(
            "ix_intelligence_snapshot_edges_target",
            "target_key",
            "snapshot_id",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[str] = mapped_column(
        ForeignKey("intelligence_snapshots.snapshot_id", ondelete="CASCADE"),
        nullable=False,
    )
    source_key: Mapped[str] = mapped_column(String(160), nullable=False)
    target_key: Mapped[str] = mapped_column(String(160), nullable=False)
    edge_type: Mapped[str] = mapped_column(String(64), nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    evidence: Mapped[list | None] = mapped_column(JSON, nullable=True)
    attributes: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class IntelligenceDiscovery(Base):
    __tablename__ = "intelligence_discoveries"
    __table_args__ = (
        Index("ix_intelligence_discoveries_snapshot", "snapshot_id"),
        Index("ix_intelligence_discoveries_source", "source_key", "created_at"),
        Index("ix_intelligence_discoveries_target", "target_key", "created_at"),
        Index("ix_intelligence_discoveries_type", "discovery_type", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    snapshot_id: Mapped[str] = mapped_column(
        ForeignKey("intelligence_snapshots.snapshot_id", ondelete="CASCADE"),
        nullable=False,
    )
    source_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    target_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    discovery_type: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="hypothesis")
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    rationale: Mapped[str] = mapped_column(Text, nullable=False, default="")
    evidence_ids: Mapped[list | None] = mapped_column(JSON, nullable=True)
    related_feature_keys: Mapped[list | None] = mapped_column(JSON, nullable=True)
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
