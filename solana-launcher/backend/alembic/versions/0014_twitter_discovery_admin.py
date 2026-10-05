"""add Twitter discovery runs and config tables"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0014_twitter_discovery_admin"
down_revision = "0013_twitter_discovery_scoring"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "twitter_discovery_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "status",
            sa.String(length=24),
            nullable=False,
            server_default="running",
        ),
        sa.Column("worker_id", sa.String(length=128), nullable=True),
        sa.Column(
            "mode",
            sa.String(length=32),
            nullable=False,
            server_default="public_no_x_api",
        ),
        sa.Column(
            "trigger",
            sa.String(length=32),
            nullable=False,
            server_default="manual",
        ),
        sa.Column("config_snapshot", sa.JSON(), nullable=True),
        sa.Column(
            "candidates_created", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("evidence_created", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rescored", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("promoted", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("skipped", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("failed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_twitter_discovery_runs_started_at",
        "twitter_discovery_runs",
        ["started_at"],
    )
    op.create_index(
        "ix_twitter_discovery_runs_status",
        "twitter_discovery_runs",
        ["status"],
    )

    op.create_table(
        "twitter_discovery_config",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "discovery_enabled", sa.Boolean(), nullable=False, server_default="1"
        ),
        sa.Column(
            "dexscreener_enabled", sa.Boolean(), nullable=False, server_default="1"
        ),
        sa.Column(
            "coinmarketcap_enabled", sa.Boolean(), nullable=False, server_default="1"
        ),
        sa.Column(
            "seed_discovery_enabled", sa.Boolean(), nullable=False, server_default="1"
        ),
        sa.Column(
            "public_web_enabled", sa.Boolean(), nullable=False, server_default="1"
        ),
        sa.Column(
            "x_api_enrichment_enabled", sa.Boolean(), nullable=False, server_default="0"
        ),
        sa.Column("cmc_limit", sa.Integer(), nullable=False, server_default="50"),
        sa.Column("rescore_limit", sa.Integer(), nullable=False, server_default="1000"),
        sa.Column("process_limit", sa.Integer(), nullable=False, server_default="250"),
        sa.Column("network_limit", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("max_depth", sa.Integer(), nullable=False, server_default="2"),
        sa.Column("min_relevance", sa.Float(), nullable=False, server_default="35"),
        sa.Column("batch_size", sa.Integer(), nullable=False, server_default="25"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("updated_by", sa.String(length=128), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("twitter_discovery_config")
    op.drop_index(
        "ix_twitter_discovery_runs_status",
        table_name="twitter_discovery_runs",
    )
    op.drop_index(
        "ix_twitter_discovery_runs_started_at",
        table_name="twitter_discovery_runs",
    )
    op.drop_table("twitter_discovery_runs")
