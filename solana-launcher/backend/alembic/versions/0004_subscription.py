"""add subscription_expires_at to users"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0004_subscription"
down_revision = "0003_hybrid_auth"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("subscription_expires_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("users", "subscription_expires_at")
