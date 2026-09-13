"""add public Twitter discovery controls"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0016_twitter_public_crawler_settings"
down_revision = "0015_twitter_crawler_settings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "twitter_crawler_settings",
        sa.Column("public_enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column(
        "twitter_crawler_settings",
        sa.Column(
            "public_dexscreener_latest",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "twitter_crawler_settings",
        sa.Column(
            "public_dexscreener_boosts",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "twitter_crawler_settings",
        sa.Column("public_db_solana_tokens", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "twitter_crawler_settings",
        sa.Column("public_cmc_limit", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "twitter_crawler_settings",
        sa.Column("public_rescore_limit", sa.Integer(), nullable=False, server_default="3000"),
    )


def downgrade() -> None:
    op.drop_column("twitter_crawler_settings", "public_rescore_limit")
    op.drop_column("twitter_crawler_settings", "public_cmc_limit")
    op.drop_column("twitter_crawler_settings", "public_db_solana_tokens")
    op.drop_column("twitter_crawler_settings", "public_dexscreener_boosts")
    op.drop_column("twitter_crawler_settings", "public_dexscreener_latest")
    op.drop_column("twitter_crawler_settings", "public_enabled")
