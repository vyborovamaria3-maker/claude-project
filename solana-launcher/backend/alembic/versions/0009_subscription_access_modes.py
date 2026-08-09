"""add explicit paid subscription mode setting"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0009_subscription_access_modes"
down_revision = "0008_subscription_orders"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "subscription_settings",
        sa.Column(
            "paid_subscriptions_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("subscription_settings", "paid_subscriptions_enabled")
