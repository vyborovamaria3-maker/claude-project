"""add social analytics hot-path indexes"""

from __future__ import annotations

from alembic import op

revision = "0013_social_analytics_indexes"
down_revision = "0012_token_latest_metrics"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_social_events_mint_platform_time",
        "social_events",
        ["mint_address", "platform", "occurred_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_social_events_mint_platform_time",
        table_name="social_events",
    )
