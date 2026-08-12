"""add advanced intelligence persistence"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0010_advanced_intelligence"
down_revision = "0009_intelligence_memory"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "campaign_fingerprints",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("snapshot_id", sa.String(length=160), nullable=False),
        sa.Column("mint_address", sa.String(length=64), nullable=False),
        sa.Column("fingerprint_hash", sa.String(length=64), nullable=False),
        sa.Column("vector", sa.JSON(), nullable=False),
        sa.Column("actors", sa.JSON(), nullable=True),
        sa.Column("narratives", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("snapshot_id", name="uq_campaign_fingerprints_snapshot"),
    )
    op.create_index("ix_campaign_fingerprints_mint_created", "campaign_fingerprints", ["mint_address", "created_at"])
    op.create_index("ix_campaign_fingerprints_hash", "campaign_fingerprints", ["fingerprint_hash"])

    op.create_table(
        "intelligence_hypothesis_states",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("hypothesis_key", sa.String(length=256), nullable=False),
        sa.Column("mint_address", sa.String(length=64), nullable=True),
        sa.Column("hypothesis_type", sa.String(length=120), nullable=False),
        sa.Column("source_key", sa.String(length=160), nullable=True),
        sa.Column("target_key", sa.String(length=160), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="hypothesis"),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0"),
        sa.Column("support_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("contradiction_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("evidence", sa.JSON(), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("hypothesis_key", name="uq_intelligence_hypothesis_key"),
    )
    op.create_index("ix_intelligence_hypothesis_status_updated", "intelligence_hypothesis_states", ["status", "updated_at"])
    op.create_index("ix_intelligence_hypothesis_mint", "intelligence_hypothesis_states", ["mint_address", "updated_at"])

    op.create_table(
        "intelligence_outcomes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("snapshot_id", sa.String(length=160), nullable=False),
        sa.Column("mint_address", sa.String(length=64), nullable=False),
        sa.Column("horizon_hours", sa.Integer(), nullable=False),
        sa.Column("baseline_price_usd", sa.Float(), nullable=True),
        sa.Column("max_price_usd", sa.Float(), nullable=True),
        sa.Column("min_price_usd", sa.Float(), nullable=True),
        sa.Column("final_price_usd", sa.Float(), nullable=True),
        sa.Column("max_multiple", sa.Float(), nullable=True),
        sa.Column("max_drawdown_pct", sa.Float(), nullable=True),
        sa.Column("outcome_label", sa.String(length=64), nullable=False, server_default="unknown"),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("evaluated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("snapshot_id", "horizon_hours", name="uq_intelligence_outcome_snapshot_horizon"),
    )
    op.create_index("ix_intelligence_outcomes_mint_horizon", "intelligence_outcomes", ["mint_address", "horizon_hours"])

    op.create_table(
        "intelligence_calibration_stats",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("model_version", sa.String(length=120), nullable=False),
        sa.Column("signal_type", sa.String(length=120), nullable=False),
        sa.Column("bucket", sa.String(length=32), nullable=False),
        sa.Column("sample_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("predicted_confidence_sum", sa.Float(), nullable=False, server_default="0"),
        sa.Column("confirmed_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("contradicted_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("model_version", "signal_type", "bucket", name="uq_intelligence_calibration_bucket"),
    )
    op.create_index("ix_intelligence_calibration_signal", "intelligence_calibration_stats", ["signal_type", "updated_at"])

    op.create_table(
        "intelligence_narrative_memory",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("narrative_key", sa.String(length=160), nullable=False),
        sa.Column("label", sa.String(length=500), nullable=False),
        sa.Column("occurrence_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("token_mints", sa.JSON(), nullable=True),
        sa.Column("actor_keys", sa.JSON(), nullable=True),
        sa.Column("examples", sa.JSON(), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("narrative_key", name="uq_intelligence_narrative_key"),
    )
    op.create_index("ix_intelligence_narrative_last", "intelligence_narrative_memory", ["last_seen_at"])


def downgrade() -> None:
    op.drop_index("ix_intelligence_narrative_last", table_name="intelligence_narrative_memory")
    op.drop_table("intelligence_narrative_memory")
    op.drop_index("ix_intelligence_calibration_signal", table_name="intelligence_calibration_stats")
    op.drop_table("intelligence_calibration_stats")
    op.drop_index("ix_intelligence_outcomes_mint_horizon", table_name="intelligence_outcomes")
    op.drop_table("intelligence_outcomes")
    op.drop_index("ix_intelligence_hypothesis_mint", table_name="intelligence_hypothesis_states")
    op.drop_index("ix_intelligence_hypothesis_status_updated", table_name="intelligence_hypothesis_states")
    op.drop_table("intelligence_hypothesis_states")
    op.drop_index("ix_campaign_fingerprints_hash", table_name="campaign_fingerprints")
    op.drop_index("ix_campaign_fingerprints_mint_created", table_name="campaign_fingerprints")
    op.drop_table("campaign_fingerprints")
