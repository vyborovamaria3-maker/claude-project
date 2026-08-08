"""persist Telegram Mini App subscription orders"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0008_subscription_orders"
down_revision = "0007_telegram_intelligence"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "subscription_orders",
        sa.Column("payload", sa.String(length=128), primary_key=True),
        sa.Column("telegram_user_id", sa.BigInteger(), nullable=False),
        sa.Column("username", sa.String(length=255), nullable=True),
        sa.Column("login", sa.String(length=32), nullable=False),
        sa.Column("currency", sa.String(length=3), nullable=False),
        sa.Column("total_amount", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="pending"),
        sa.Column("password_ciphertext", sa.Text(), nullable=True),
        sa.Column("invoice_link", sa.Text(), nullable=True),
        sa.Column("provider_charge_id", sa.String(length=255), nullable=True),
        sa.Column("telegram_payment_charge_id", sa.String(length=255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint(
            "telegram_payment_charge_id",
            name="uq_subscription_orders_telegram_payment_charge_id",
        ),
    )
    op.create_index(
        "ix_subscription_orders_telegram_user_id",
        "subscription_orders",
        ["telegram_user_id"],
    )
    op.create_index("ix_subscription_orders_login", "subscription_orders", ["login"])
    op.create_index("ix_subscription_orders_status", "subscription_orders", ["status"])
    op.create_index(
        "uq_subscription_orders_pending_login",
        "subscription_orders",
        ["login"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index("uq_subscription_orders_pending_login", table_name="subscription_orders")
    op.drop_index("ix_subscription_orders_status", table_name="subscription_orders")
    op.drop_index("ix_subscription_orders_login", table_name="subscription_orders")
    op.drop_index("ix_subscription_orders_telegram_user_id", table_name="subscription_orders")
    op.drop_table("subscription_orders")
