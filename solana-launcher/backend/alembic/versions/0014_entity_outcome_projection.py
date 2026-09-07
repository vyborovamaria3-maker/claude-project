"""add entity outcome projection for intelligence reliability"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0014_entity_outcome_projection"
down_revision = "0013_social_analytics_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "intelligence_entity_outcomes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("entity_key", sa.String(length=160), nullable=False),
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("mint_address", sa.String(length=64), nullable=False),
        sa.Column("horizon_hours", sa.Integer(), nullable=False),
        sa.Column("snapshot_id", sa.String(length=160), nullable=False),
        sa.Column("max_multiple", sa.Float(), nullable=True),
        sa.Column("max_drawdown_pct", sa.Float(), nullable=True),
        sa.Column("outcome_label", sa.String(length=64), nullable=False),
        sa.Column("evaluated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "entity_key",
            "mint_address",
            "horizon_hours",
            name="uq_intelligence_entity_outcome",
        ),
    )
    op.create_index(
        "ix_intelligence_entity_outcomes_entity_horizon",
        "intelligence_entity_outcomes",
        ["entity_key", "horizon_hours"],
        unique=False,
    )
    op.create_index(
        "ix_intelligence_entity_outcomes_horizon_mint",
        "intelligence_entity_outcomes",
        ["horizon_hours", "mint_address"],
        unique=False,
    )
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

    # Backfill exactly the same causal selection rule used by the runtime:
    # the earliest retained snapshot for each entity + token, then its matured
    # 72h outcome. Later snapshots must never create extra votes for one launch.
    op.execute(
        sa.text(
            """
            INSERT INTO intelligence_entity_outcomes (
                entity_key,
                entity_type,
                mint_address,
                horizon_hours,
                snapshot_id,
                max_multiple,
                max_drawdown_pct,
                outcome_label,
                evaluated_at,
                updated_at
            )
            SELECT
                ranked.entity_key,
                ranked.entity_type,
                ranked.mint_address,
                72,
                ranked.snapshot_id,
                outcome.max_multiple,
                outcome.max_drawdown_pct,
                outcome.outcome_label,
                outcome.evaluated_at,
                outcome.evaluated_at
            FROM (
                SELECT
                    link.entity_key AS entity_key,
                    link.entity_type AS entity_type,
                    snapshot.mint_address AS mint_address,
                    snapshot.snapshot_id AS snapshot_id,
                    ROW_NUMBER() OVER (
                        PARTITION BY link.entity_key, snapshot.mint_address
                        ORDER BY snapshot.created_at ASC, snapshot.snapshot_id ASC
                    ) AS rn
                FROM intelligence_snapshot_entities AS link
                JOIN intelligence_snapshots AS snapshot
                  ON snapshot.snapshot_id = link.snapshot_id
                WHERE link.entity_type IN ('x_account', 'tg_channel', 'wallet')
            ) AS ranked
            JOIN intelligence_outcomes AS outcome
              ON outcome.snapshot_id = ranked.snapshot_id
             AND outcome.horizon_hours = 72
            WHERE ranked.rn = 1
              AND outcome.max_multiple IS NOT NULL
            """
        )
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
    op.drop_index(
        "ix_intelligence_entity_outcomes_horizon_mint",
        table_name="intelligence_entity_outcomes",
    )
    op.drop_index(
        "ix_intelligence_entity_outcomes_entity_horizon",
        table_name="intelligence_entity_outcomes",
    )
    op.drop_table("intelligence_entity_outcomes")
