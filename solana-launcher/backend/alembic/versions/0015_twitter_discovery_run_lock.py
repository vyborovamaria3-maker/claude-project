"""add atomic Twitter discovery run lock"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0015_twitter_discovery_run_lock"
down_revision = "0014_twitter_discovery_admin"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "twitter_discovery_run_locks",
        sa.Column("lock_key", sa.String(length=64), primary_key=True),
        sa.Column("owner_token", sa.String(length=64), nullable=False),
        sa.Column(
            "run_id",
            sa.Integer(),
            sa.ForeignKey("twitter_discovery_runs.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_twitter_discovery_run_locks_lease",
        "twitter_discovery_run_locks",
        ["lease_expires_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_twitter_discovery_run_locks_lease",
        table_name="twitter_discovery_run_locks",
    )
    op.drop_table("twitter_discovery_run_locks")
