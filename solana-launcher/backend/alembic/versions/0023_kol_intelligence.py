"""add KOL Twitter identity intelligence persistence"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0023_kol_intelligence"
down_revision = "0022_merge_discovery_lock"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "kol_profiles",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("twitter_handle", sa.String(length=64), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=True),
        sa.Column("avatar_url", sa.String(length=1024), nullable=True),
        sa.Column("twitter_url", sa.String(length=512), nullable=True),
        sa.Column("telegram_url", sa.String(length=512), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0"),
        sa.Column("verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("source_meta", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("twitter_handle", name="uq_kol_profiles_twitter_handle"),
    )
    op.create_index("ix_kol_profiles_confidence", "kol_profiles", ["confidence"])
    op.create_index("ix_kol_profiles_verified_updated", "kol_profiles", ["verified", "updated_at"])

    op.create_table(
        "kol_wallet_attributions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("kol_id", sa.Integer(), sa.ForeignKey("kol_profiles.id", ondelete="CASCADE"), nullable=False),
        sa.Column("analytics_wallet_id", sa.Integer(), sa.ForeignKey("wallets.id", ondelete="SET NULL"), nullable=True),
        sa.Column("address", sa.String(length=128), nullable=False),
        sa.Column("chain", sa.String(length=32), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0"),
        sa.Column("verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("source_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("kol_id", "chain", "address", name="uq_kol_wallet_attribution"),
    )
    op.create_index("ix_kol_wallet_attributions_kol_id", "kol_wallet_attributions", ["kol_id"])
    op.create_index("ix_kol_wallet_attributions_analytics_wallet_id", "kol_wallet_attributions", ["analytics_wallet_id"])
    op.create_index("ix_kol_wallet_address_chain", "kol_wallet_attributions", ["address", "chain"])
    op.create_index("ix_kol_wallet_verified_confidence", "kol_wallet_attributions", ["verified", "confidence"])

    op.create_table(
        "kol_wallet_evidence",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("wallet_id", sa.Integer(), sa.ForeignKey("kol_wallet_attributions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source", sa.String(length=120), nullable=False),
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("fingerprint", sa.String(length=64), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="0"),
        sa.Column("verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("detail", sa.String(length=1000), nullable=True),
        sa.Column("source_url", sa.String(length=1024), nullable=True),
        sa.Column("raw_payload", sa.JSON(), nullable=True),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("wallet_id", "source", "kind", "fingerprint", name="uq_kol_wallet_evidence_fingerprint"),
    )
    op.create_index("ix_kol_wallet_evidence_wallet_id", "kol_wallet_evidence", ["wallet_id"])
    op.create_index("ix_kol_wallet_evidence_source_observed", "kol_wallet_evidence", ["source", "observed_at"])

    op.create_table(
        "kol_wallet_metrics",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("wallet_id", sa.Integer(), sa.ForeignKey("kol_wallet_attributions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("timeframe_days", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(length=120), nullable=False, server_default="internal"),
        sa.Column("pnl_value", sa.Float(), nullable=True),
        sa.Column("pnl_currency", sa.String(length=16), nullable=True),
        sa.Column("realized_pnl_usd", sa.Float(), nullable=True),
        sa.Column("unrealized_pnl_usd", sa.Float(), nullable=True),
        sa.Column("win_rate", sa.Float(), nullable=True),
        sa.Column("wins", sa.Integer(), nullable=True),
        sa.Column("losses", sa.Integer(), nullable=True),
        sa.Column("volume_usd", sa.Float(), nullable=True),
        sa.Column("trade_count", sa.Integer(), nullable=True),
        sa.Column("last_trade_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("raw_payload", sa.JSON(), nullable=True),
        sa.Column("calculated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("wallet_id", "timeframe_days", "source", name="uq_kol_wallet_metric_window_source"),
    )
    op.create_index("ix_kol_wallet_metrics_wallet_id", "kol_wallet_metrics", ["wallet_id"])
    op.create_index("ix_kol_wallet_metrics_window_calculated", "kol_wallet_metrics", ["timeframe_days", "calculated_at"])

    op.create_table(
        "kol_source_syncs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("source", sa.String(length=120), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="unknown"),
        sa.Column("records_seen", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("detail", sa.String(length=1000), nullable=True),
        sa.Column("last_success_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("source", name="uq_kol_source_sync_source"),
    )


def downgrade() -> None:
    op.drop_table("kol_source_syncs")
    op.drop_table("kol_wallet_metrics")
    op.drop_table("kol_wallet_evidence")
    op.drop_table("kol_wallet_attributions")
    op.drop_table("kol_profiles")
