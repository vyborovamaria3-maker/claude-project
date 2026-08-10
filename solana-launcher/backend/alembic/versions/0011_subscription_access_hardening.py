"""separate subscription access login from email identity"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0011_subscription_access_hardening"
down_revision = "0010_telegram_profile_metadata"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("access_login", sa.String(length=32), nullable=True))

    # Older subscription code stored the Mini App login in users.email. Only
    # migrate values that cannot be ordinary email addresses and belong to a
    # Telegram-backed account.
    op.execute(
        sa.text(
            """
            UPDATE users
            SET access_login = email,
                email = NULL
            WHERE telegram_id IS NOT NULL
              AND hashed_password IS NOT NULL
              AND email IS NOT NULL
              AND email NOT LIKE '%@%'
            """
        )
    )

    op.create_index("ix_users_access_login", "users", ["access_login"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_users_access_login", table_name="users")
    op.drop_column("users", "access_login")
