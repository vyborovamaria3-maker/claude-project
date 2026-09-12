"""add Twitter discovery frontier and provenance"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0012_twitter_discovery_frontier"
down_revision = "0011_twitter_account_registry"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "twitter_discovery_candidates",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("candidate_key", sa.String(length=160), nullable=False),
        sa.Column("twitter_id", sa.String(length=32), nullable=True),
        sa.Column("username", sa.String(length=64), nullable=True),
        sa.Column("display_name", sa.String(length=255), nullable=True),
        sa.Column(
            "account_type_hint",
            sa.String(length=32),
            nullable=False,
            server_default="unknown",
        ),
        sa.Column("status", sa.String(length=24), nullable=False, server_default="queued"),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="50"),
        sa.Column("depth", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("relevance_hint", sa.Float(), nullable=False, server_default="0"),
        sa.Column(
            "account_id",
            sa.Integer(),
            sa.ForeignKey("twitter_accounts.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "parent_account_id",
            sa.Integer(),
            sa.ForeignKey("twitter_accounts.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("lease_owner", sa.String(length=128), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("meta", sa.JSON(), nullable=True),
        sa.UniqueConstraint(
            "candidate_key",
            name="uq_twitter_discovery_candidates_key",
        ),
        sa.UniqueConstraint(
            "twitter_id",
            name="uq_twitter_discovery_candidates_twitter_id",
        ),
    )
    op.create_index(
        "ix_twitter_discovery_candidates_queue",
        "twitter_discovery_candidates",
        ["status", "priority", "next_attempt_at"],
    )
    op.create_index(
        "ix_twitter_discovery_candidates_username",
        "twitter_discovery_candidates",
        ["username"],
    )
    op.create_index(
        "ix_twitter_discovery_candidates_depth",
        "twitter_discovery_candidates",
        ["depth", "priority"],
    )

    op.create_table(
        "twitter_discovery_evidence",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "candidate_id",
            sa.Integer(),
            sa.ForeignKey("twitter_discovery_candidates.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source_type", sa.String(length=48), nullable=False),
        sa.Column("source_ref", sa.String(length=512), nullable=False, server_default=""),
        sa.Column(
            "discovery_reason",
            sa.String(length=96),
            nullable=False,
            server_default="unknown",
        ),
        sa.Column("query", sa.Text(), nullable=True),
        sa.Column("source_url", sa.String(length=1024), nullable=True),
        sa.Column(
            "observed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("raw", sa.JSON(), nullable=True),
        sa.UniqueConstraint(
            "candidate_id",
            "source_type",
            "source_ref",
            "discovery_reason",
            name="uq_twitter_discovery_evidence_source",
        ),
    )
    op.create_index(
        "ix_twitter_discovery_evidence_candidate_time",
        "twitter_discovery_evidence",
        ["candidate_id", "observed_at"],
    )
    op.create_index(
        "ix_twitter_discovery_evidence_source",
        "twitter_discovery_evidence",
        ["source_type", "observed_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_twitter_discovery_evidence_source",
        table_name="twitter_discovery_evidence",
    )
    op.drop_index(
        "ix_twitter_discovery_evidence_candidate_time",
        table_name="twitter_discovery_evidence",
    )
    op.drop_table("twitter_discovery_evidence")

    op.drop_index(
        "ix_twitter_discovery_candidates_depth",
        table_name="twitter_discovery_candidates",
    )
    op.drop_index(
        "ix_twitter_discovery_candidates_username",
        table_name="twitter_discovery_candidates",
    )
    op.drop_index(
        "ix_twitter_discovery_candidates_queue",
        table_name="twitter_discovery_candidates",
    )
    op.drop_table("twitter_discovery_candidates")
