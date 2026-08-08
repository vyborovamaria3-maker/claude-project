"""persist Solana subscription settings and orders"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0008_subscription_orders"
down_revision = "0007_telegram_intelligence"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "subscription_settings",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "monthly_price_sol",
            sa.Numeric(precision=20, scale=9),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "monthly_price_usdt",
            sa.Numeric(precision=20, scale=6),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "free_demo_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column("demo_days", sa.Integer(), nullable=False, server_default="30"),
        sa.Column(
            "solana_recipient_wallet",
            sa.String(length=64),
            nullable=False,
            server_default="",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    settings_table = sa.table(
        "subscription_settings",
        sa.column("id", sa.Integer()),
        sa.column("monthly_price_sol", sa.Numeric(20, 9)),
        sa.column("monthly_price_usdt", sa.Numeric(20, 6)),
        sa.column("free_demo_enabled", sa.Boolean()),
        sa.column("demo_days", sa.Integer()),
        sa.column("solana_recipient_wallet", sa.String(64)),
    )
    op.bulk_insert(
        settings_table,
        [
            {
                "id": 1,
                "monthly_price_sol": 0,
                "monthly_price_usdt": 0,
                "free_demo_enabled": False,
                "demo_days": 30,
                "solana_recipient_wallet": "",
            }
        ],
    )

    op.create_table(
        "subscription_orders",
        sa.Column("payload", sa.String(length=128), primary_key=True),
        sa.Column("telegram_user_id", sa.BigInteger(), nullable=False),
        sa.Column("username", sa.String(length=255), nullable=True),
        sa.Column("login", sa.String(length=32), nullable=False),
        sa.Column("currency", sa.String(length=8), nullable=False),
        sa.Column("total_amount", sa.BigInteger(), nullable=False),
        sa.Column("access_days", sa.Integer(), nullable=False, server_default="30"),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="pending"),
        sa.Column("password_ciphertext", sa.Text(), nullable=True),
        sa.Column("recipient_wallet", sa.String(length=64), nullable=True),
        sa.Column("payment_reference", sa.String(length=64), nullable=True),
        sa.Column("payment_url", sa.Text(), nullable=True),
        sa.Column("payment_signature", sa.String(length=128), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint(
            "payment_reference",
            name="uq_subscription_orders_payment_reference",
        ),
        sa.UniqueConstraint(
            "payment_signature",
            name="uq_subscription_orders_payment_signature",
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
        sqlite_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index("uq_subscription_orders_pending_login", table_name="subscription_orders")
    op.drop_index("ix_subscription_orders_status", table_name="subscription_orders")
    op.drop_index("ix_subscription_orders_login", table_name="subscription_orders")
    op.drop_index("ix_subscription_orders_telegram_user_id", table_name="subscription_orders")
    op.drop_table("subscription_orders")
    op.drop_table("subscription_settings")
