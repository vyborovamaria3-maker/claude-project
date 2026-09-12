"""add Twitter discovery scoring"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0013_twitter_discovery_scoring"
down_revision = "0012_twitter_discovery_frontier"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "twitter_discovery_scores",
        sa.Column(
            "candidate_id",
            sa.Integer(),
            sa.ForeignKey("twitter_discovery_candidates.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("discovery_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0"),
        sa.Column("relevance_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("source_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("graph_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("engagement_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("early_signal_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("recency_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("evidence_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("source_type_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "score_version",
            sa.String(length=64),
            nullable=False,
            server_default="discovery-score-v1",
        ),
        sa.Column(
            "scored_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("components", sa.JSON(), nullable=True),
    )
    op.create_index(
        "ix_twitter_discovery_scores_score",
        "twitter_discovery_scores",
        ["discovery_score"],
    )
    op.create_index(
        "ix_twitter_discovery_scores_scored_at",
        "twitter_discovery_scores",
        ["scored_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_twitter_discovery_scores_scored_at",
        table_name="twitter_discovery_scores",
    )
    op.drop_index(
        "ix_twitter_discovery_scores_score",
        table_name="twitter_discovery_scores",
    )
    op.drop_table("twitter_discovery_scores")
