"""Fence stale Telegram login completions after a session is revoked.

Revision ID: 0026_tginvite_session_generation
Revises: 0025_telegram_invite_sessions
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0026_tginvite_session_generation"
down_revision = "0025_telegram_invite_sessions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "telegram_invite_sessions",
        sa.Column("generation", sa.Integer(), nullable=False, server_default="0"),
    )
    # Keep a tombstone after revocation to reject stale, in-flight logins.
    op.alter_column(
        "telegram_invite_sessions",
        "encrypted_payload",
        existing_type=sa.Text(),
        nullable=True,
    )


def downgrade() -> None:
    # Remove tombstones before restoring the old non-null constraint.
    op.execute("DELETE FROM telegram_invite_sessions WHERE encrypted_payload IS NULL")
    op.alter_column(
        "telegram_invite_sessions",
        "encrypted_payload",
        existing_type=sa.Text(),
        nullable=False,
    )
    op.drop_column("telegram_invite_sessions", "generation")
