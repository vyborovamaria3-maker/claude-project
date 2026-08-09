"""persist verified Telegram profile metadata"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0010_telegram_profile_metadata"
down_revision = "0009_subscription_access_modes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("subscription_orders", sa.Column("telegram_profile", sa.JSON(), nullable=True))

    op.add_column("users", sa.Column("telegram_language_code", sa.String(length=32), nullable=True))
    op.add_column("users", sa.Column("telegram_is_premium", sa.Boolean(), nullable=True))
    op.add_column(
        "users",
        sa.Column("telegram_added_to_attachment_menu", sa.Boolean(), nullable=True),
    )
    op.add_column("users", sa.Column("telegram_allows_write_to_pm", sa.Boolean(), nullable=True))
    op.add_column("users", sa.Column("telegram_profile", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "telegram_profile")
    op.drop_column("users", "telegram_allows_write_to_pm")
    op.drop_column("users", "telegram_added_to_attachment_menu")
    op.drop_column("users", "telegram_is_premium")
    op.drop_column("users", "telegram_language_code")
    op.drop_column("subscription_orders", "telegram_profile")
