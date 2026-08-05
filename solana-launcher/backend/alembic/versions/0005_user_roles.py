"""add role column to users"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0005_user_roles"
down_revision = "0004_subscription"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "role",
            sa.String(length=16),
            nullable=False,
            server_default=sa.text("'user'"),
        ),
    )
    op.execute(
        sa.text(
            "UPDATE users "
            "SET role = CASE WHEN is_superuser THEN 'admin' ELSE 'user' END "
            "WHERE role IS NULL OR role = '' OR role <> CASE WHEN is_superuser THEN 'admin' ELSE 'user' END"
        )
    )
    op.create_index(op.f("ix_users_role"), "users", ["role"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_users_role"), table_name="users")
    op.drop_column("users", "role")
