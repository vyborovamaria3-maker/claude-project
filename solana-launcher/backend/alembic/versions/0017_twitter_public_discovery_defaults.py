"""align public Twitter discovery server defaults"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0017_twitter_public_defaults"
down_revision = "0016_twitter_public_settings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 0016 already seeds the intended values on fresh installs. This follow-up
    # only aligns database-level defaults and deliberately does not rewrite the
    # singleton row, because false/false/0 can also be an intentional admin choice.
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


def downgrade() -> None:
    # 0016 uses the same defaults, so downgrading this compatibility step must
    # not change operator configuration or reintroduce the old disabled values.
    pass
