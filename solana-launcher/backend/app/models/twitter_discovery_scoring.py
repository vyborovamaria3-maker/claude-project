from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, ForeignKey, Index, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class TwitterDiscoveryScore(Base):
    __tablename__ = "twitter_discovery_scores"
    __table_args__ = (
        Index("ix_twitter_discovery_scores_score", "discovery_score"),
        Index("ix_twitter_discovery_scores_scored_at", "scored_at"),
    )

    candidate_id: Mapped[int] = mapped_column(
        ForeignKey("twitter_discovery_candidates.id", ondelete="CASCADE"),
        primary_key=True,
    )
    discovery_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    relevance_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    source_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    graph_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    engagement_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    early_signal_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    recency_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    evidence_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    source_type_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    score_version: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        default="discovery-score-v1",
    )
    scored_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utcnow,
    )
    components: Mapped[dict | None] = mapped_column(JSON, nullable=True)
