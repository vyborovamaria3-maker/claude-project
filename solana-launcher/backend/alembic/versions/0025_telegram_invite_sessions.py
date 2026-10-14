"""Create encrypted, owner-scoped Telegram session vault."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0025_telegram_invite_sessions"
down_revision = "0024_kol_trade_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "telegram_invite_sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "owner_id",
            sa.Uuid(as_uuid=False),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("encrypted_payload", sa.Text(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.UniqueConstraint("owner_id", name="uq_telegram_invite_sessions_owner"),
    )
    op.create_index(
        "ix_telegram_invite_sessions_owner_id", "telegram_invite_sessions", ["owner_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_telegram_invite_sessions_owner_id", table_name="telegram_invite_sessions")
    op.drop_table("telegram_invite_sessions")
