"""align public Twitter discovery defaults with the runtime collector"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0017_twitter_public_discovery_defaults"
down_revision = "0016_twitter_public_crawler_settings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "twitter_crawler_settings",
        "public_dexscreener_latest",
        existing_type=sa.Boolean(),
        nullable=False,
        server_default=sa.true(),
    )
    op.alter_column(
        "twitter_crawler_settings",
        "public_dexscreener_boosts",
        existing_type=sa.Boolean(),
        nullable=False,
        server_default=sa.true(),
    )
    op.alter_column(
        "twitter_crawler_settings",
        "public_db_solana_tokens",
        existing_type=sa.Integer(),
        nullable=False,
        server_default="500",
    )

    # 0016 originally seeded the public collector with every discovery source
    # disabled. Upgrade untouched singleton rows to the intended safe defaults,
    # while leaving any non-default/admin-edited configuration alone.
    op.execute(
        sa.text(
            """
            UPDATE twitter_crawler_settings
            SET public_dexscreener_latest = TRUE,
                public_dexscreener_boosts = TRUE,
                public_db_solana_tokens = 500,
                updated_at = NOW()
            WHERE id = 1
              AND public_enabled = TRUE
              AND public_dexscreener_latest = FALSE
              AND public_dexscreener_boosts = FALSE
              AND public_db_solana_tokens = 0
              AND public_cmc_limit = 0
              AND public_rescore_limit = 3000
            """
        )
    )


def downgrade() -> None:
    op.alter_column(
        "twitter_crawler_settings",
        "public_db_solana_tokens",
        existing_type=sa.Integer(),
        nullable=False,
        server_default="0",
    )
    op.alter_column(
        "twitter_crawler_settings",
        "public_dexscreener_boosts",
        existing_type=sa.Boolean(),
        nullable=False,
        server_default=sa.false(),
    )
    op.alter_column(
        "twitter_crawler_settings",
        "public_dexscreener_latest",
        existing_type=sa.Boolean(),
        nullable=False,
        server_default=sa.false(),
    )
