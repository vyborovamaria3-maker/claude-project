"""add analytics hot-path indexes"""

from __future__ import annotations

from alembic import op

revision = "0011_analytics_hot_path_indexes"
down_revision = "0010_advanced_intelligence"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_wallet_trades_wallet_buy_timestamp",
        "wallet_trades",
        ["wallet_id", "buy_timestamp"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_wallet_trades_wallet_buy_timestamp",
        table_name="wallet_trades",
    )
