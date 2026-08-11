"""add persistent intelligence memory"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0009_intelligence_memory"
down_revision = "0008_subscription_orders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "intelligence_snapshots",
        sa.Column("snapshot_id", sa.String(length=160), primary_key=True),
        sa.Column("mint_address", sa.String(length=64), nullable=False),
        sa.Column("symbol", sa.String(length=32), nullable=True),
        sa.Column("token_name", sa.String(length=128), nullable=True),
        sa.Column("snapshot_version", sa.String(length=80), nullable=False),
        sa.Column("graph_version", sa.String(length=80), nullable=False),
        sa.Column("feature_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("missing_feature_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("model", sa.String(length=160), nullable=True),
        sa.Column("provider", sa.String(length=64), nullable=True),
        sa.Column("prompt_version", sa.String(length=80), nullable=True),
        sa.Column("overall_confidence", sa.Float(), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("ai_result", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_intelligence_snapshots_mint_created", "intelligence_snapshots", ["mint_address", "created_at"])
    op.create_index("ix_intelligence_snapshots_created", "intelligence_snapshots", ["created_at"])

    op.create_table(
        "intelligence_entities",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("entity_key", sa.String(length=160), nullable=False),
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("label", sa.String(length=1000), nullable=False),
        sa.Column("occurrence_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("attributes", sa.JSON(), nullable=True),
        sa.UniqueConstraint("entity_key", name="uq_intelligence_entities_key"),
    )
    op.create_index("ix_intelligence_entities_type_last", "intelligence_entities", ["entity_type", "last_seen_at"])
    op.create_index("ix_intelligence_entities_label", "intelligence_entities", ["label"])

    op.create_table(
        "intelligence_snapshot_entities",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("snapshot_id", sa.String(length=160), sa.ForeignKey("intelligence_snapshots.snapshot_id", ondelete="CASCADE"), nullable=False),
        sa.Column("entity_key", sa.String(length=160), nullable=False),
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("label", sa.String(length=1000), nullable=False),
        sa.Column("attributes", sa.JSON(), nullable=True),
        sa.UniqueConstraint("snapshot_id", "entity_key", name="uq_intelligence_snapshot_entity"),
    )
    op.create_index("ix_intelligence_snapshot_entities_entity", "intelligence_snapshot_entities", ["entity_key", "snapshot_id"])

    op.create_table(
        "intelligence_edges",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("source_key", sa.String(length=160), nullable=False),
        sa.Column("target_key", sa.String(length=160), nullable=False),
        sa.Column("edge_type", sa.String(length=64), nullable=False),
        sa.Column("occurrence_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("confidence_sum", sa.Float(), nullable=False, server_default="0"),
        sa.Column("max_confidence", sa.Float(), nullable=False, server_default="0"),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_snapshot_id", sa.String(length=160), nullable=True),
        sa.Column("evidence", sa.JSON(), nullable=True),
        sa.Column("attributes", sa.JSON(), nullable=True),
        sa.UniqueConstraint("source_key", "target_key", "edge_type", name="uq_intelligence_edges_triplet"),
    )
    op.create_index("ix_intelligence_edges_source", "intelligence_edges", ["source_key", "last_seen_at"])
    op.create_index("ix_intelligence_edges_target", "intelligence_edges", ["target_key", "last_seen_at"])
    op.create_index("ix_intelligence_edges_type", "intelligence_edges", ["edge_type", "last_seen_at"])

    op.create_table(
        "intelligence_discoveries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("snapshot_id", sa.String(length=160), sa.ForeignKey("intelligence_snapshots.snapshot_id", ondelete="CASCADE"), nullable=False),
        sa.Column("source_key", sa.String(length=512), nullable=True),
        sa.Column("target_key", sa.String(length=512), nullable=True),
        sa.Column("discovery_type", sa.String(length=120), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="hypothesis"),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0"),
        sa.Column("rationale", sa.Text(), nullable=False, server_default=""),
        sa.Column("evidence_ids", sa.JSON(), nullable=True),
        sa.Column("related_feature_keys", sa.JSON(), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_intelligence_discoveries_snapshot", "intelligence_discoveries", ["snapshot_id"])
    op.create_index("ix_intelligence_discoveries_source", "intelligence_discoveries", ["source_key", "created_at"])
    op.create_index("ix_intelligence_discoveries_target", "intelligence_discoveries", ["target_key", "created_at"])
    op.create_index("ix_intelligence_discoveries_type", "intelligence_discoveries", ["discovery_type", "created_at"])


def downgrade() -> None:
    op.drop_table("intelligence_discoveries")
    op.drop_table("intelligence_edges")
    op.drop_table("intelligence_snapshot_entities")
    op.drop_table("intelligence_entities")
    op.drop_table("intelligence_snapshots")
