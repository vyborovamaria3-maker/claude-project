"""add hypothesis endpoint indexes for relevant-history lookups"""

from __future__ import annotations

from alembic import op

revision = "0015_hypothesis_endpoint_indexes"
down_revision = "0014_entity_outcome_projection"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_intelligence_hypothesis_source_updated",
        "intelligence_hypothesis_states",
        ["source_key", "updated_at"],
        unique=False,
    )
    op.create_index(
        "ix_intelligence_hypothesis_target_updated",
        "intelligence_hypothesis_states",
        ["target_key", "updated_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_intelligence_hypothesis_target_updated",
        table_name="intelligence_hypothesis_states",
    )
    op.drop_index(
        "ix_intelligence_hypothesis_source_updated",
        table_name="intelligence_hypothesis_states",
    )
