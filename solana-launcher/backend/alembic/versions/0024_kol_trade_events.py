"""add granular KOL trade event ledger and sync state"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0024_kol_trade_events"
down_revision = "0023_kol_intelligence"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "kol_trade_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "analytics_wallet_id",
            sa.Integer(),
            sa.ForeignKey("wallets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("chain", sa.String(length=32), nullable=False, server_default="solana"),
        sa.Column("address", sa.String(length=128), nullable=False),
        sa.Column("tx_signature", sa.String(length=128), nullable=False),
        sa.Column("event_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("side", sa.String(length=8), nullable=False),
        sa.Column("mint_address", sa.String(length=128), nullable=False),
        sa.Column("token_symbol", sa.String(length=64), nullable=True),
        sa.Column("token_name", sa.String(length=255), nullable=True),
        sa.Column("amount", sa.Float(), nullable=False, server_default="0"),
        sa.Column("price_usd", sa.Float(), nullable=True),
        sa.Column("value_usd", sa.Float(), nullable=True),
        sa.Column("counterparty_mint", sa.String(length=128), nullable=True),
        sa.Column("counterparty_amount", sa.Float(), nullable=True),
        sa.Column("program", sa.String(length=120), nullable=True),
        sa.Column("source", sa.String(length=120), nullable=False, server_default="solana_tracker"),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("raw_payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint(
            "analytics_wallet_id",
            "tx_signature",
            "event_index",
            name="uq_kol_trade_event_wallet_tx_index",
        ),
    )
    op.create_index("ix_kol_trade_events_analytics_wallet_id", "kol_trade_events", ["analytics_wallet_id"])
    op.create_index("ix_kol_trade_events_address", "kol_trade_events", ["address"])
    op.create_index("ix_kol_trade_events_occurred_at", "kol_trade_events", ["occurred_at"])
    op.create_index("ix_kol_trade_events_wallet_time", "kol_trade_events", ["analytics_wallet_id", "occurred_at"])
    op.create_index("ix_kol_trade_events_mint_time", "kol_trade_events", ["mint_address", "occurred_at"])
    op.create_index("ix_kol_trade_events_side_time", "kol_trade_events", ["side", "occurred_at"])

    op.create_table(
        "kol_trade_sync_states",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "analytics_wallet_id",
            sa.Integer(),
            sa.ForeignKey("wallets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source", sa.String(length=120), nullable=False, server_default="solana_tracker"),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
        sa.Column("events_seen", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_cursor", sa.String(length=255), nullable=True),
        sa.Column("backfill_complete", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("detail", sa.String(length=1000), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("analytics_wallet_id", name="uq_kol_trade_sync_wallet"),
    )
    op.create_index("ix_kol_trade_sync_states_analytics_wallet_id", "kol_trade_sync_states", ["analytics_wallet_id"])
    op.create_index("ix_kol_trade_sync_last_attempt", "kol_trade_sync_states", ["last_attempt_at"])


def downgrade() -> None:
    op.drop_table("kol_trade_sync_states")
    op.drop_table("kol_trade_events")
