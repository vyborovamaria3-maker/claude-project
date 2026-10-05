"""add editable Twitter crawler settings"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0015_twitter_crawler_settings"
down_revision = "0014_twitter_crawler_runs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    table = op.create_table(
        "twitter_crawler_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("query_limit", sa.Integer(), nullable=False, server_default="50"),
        sa.Column("process_limit", sa.Integer(), nullable=False, server_default="250"),
        sa.Column("batch_size", sa.Integer(), nullable=False, server_default="25"),
        sa.Column("max_depth", sa.Integer(), nullable=False, server_default="2"),
        sa.Column("min_relevance", sa.Float(), nullable=False, server_default="35"),
        sa.Column("network_mode", sa.String(length=16), nullable=False, server_default="following"),
        sa.Column("network_limit", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("lease_seconds", sa.Integer(), nullable=False, server_default="300"),
        sa.Column("rescore_limit", sa.Integer(), nullable=False, server_default="1500"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.bulk_insert(
        table,
        [
            {
                "id": 1,
                "enabled": True,
                "query_limit": 50,
                "process_limit": 250,
                "batch_size": 25,
                "max_depth": 2,
                "min_relevance": 35.0,
                "network_mode": "following",
                "network_limit": 100,
                "lease_seconds": 300,
                "rescore_limit": 1500,
            }
        ],
    )


def downgrade() -> None:
    op.drop_table("twitter_crawler_settings")
