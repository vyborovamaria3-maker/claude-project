"""analytics schema"""

from alembic import op
import sqlalchemy as sa


revision = "0002_analytics"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tokens",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("mint_address", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=True),
        sa.Column("symbol", sa.String(length=64), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("creator_wallet", sa.String(length=64), nullable=True),
        sa.Column("creation_date", sa.DateTime(timezone=True), nullable=True),
        sa.Column("migrated_to_raydium", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("migration_date", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False, server_default=sa.text("'active'")),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("mint_address", name="uq_tokens_mint_address"),
    )
    op.create_index(op.f("ix_tokens_id"), "tokens", ["id"], unique=False)
    op.create_index(op.f("ix_tokens_mint_address"), "tokens", ["mint_address"], unique=True)
    op.create_index("ix_tokens_status_migration_date", "tokens", ["status", "migration_date"], unique=False)
    op.create_index("ix_tokens_creator_wallet", "tokens", ["creator_wallet"], unique=False)

    op.create_table(
        "wallets",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("wallet_address", sa.String(length=64), nullable=False),
        sa.Column("first_seen_date", sa.DateTime(timezone=True), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("wallet_address", name="uq_wallets_wallet_address"),
    )
    op.create_index(op.f("ix_wallets_id"), "wallets", ["id"], unique=False)
    op.create_index(op.f("ix_wallets_wallet_address"), "wallets", ["wallet_address"], unique=True)

    op.create_table(
        "collector_jobs",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("job_name", sa.String(length=128), nullable=False),
        sa.Column("last_run", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False, server_default=sa.text("'pending'")),
        sa.Column("meta", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("job_name", name="uq_collector_jobs_job_name"),
    )
    op.create_index(op.f("ix_collector_jobs_id"), "collector_jobs", ["id"], unique=False)
    op.create_index(op.f("ix_collector_jobs_job_name"), "collector_jobs", ["job_name"], unique=True)

    op.create_table(
        "token_metrics",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("token_id", sa.Integer(), sa.ForeignKey("tokens.id", ondelete="CASCADE"), nullable=False),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("price_usd", sa.Float(), nullable=True),
        sa.Column("ath_usd", sa.Float(), nullable=True),
        sa.Column("ath_date", sa.DateTime(timezone=True), nullable=True),
        sa.Column("market_cap", sa.Float(), nullable=True),
        sa.Column("fdv", sa.Float(), nullable=True),
        sa.Column("liquidity_usd", sa.Float(), nullable=True),
        sa.Column("volume_24h", sa.Float(), nullable=True),
        sa.Column("tx_count_24h", sa.Integer(), nullable=True),
        sa.Column("holder_count", sa.Integer(), nullable=True),
        sa.Column("twitter_url", sa.String(length=512), nullable=True),
        sa.Column("telegram_url", sa.String(length=512), nullable=True),
        sa.Column("discord_url", sa.String(length=512), nullable=True),
        sa.Column("website_url", sa.String(length=512), nullable=True),
        sa.Column("social_engagements", sa.JSON(), nullable=True),
    )
    op.create_index(op.f("ix_token_metrics_id"), "token_metrics", ["id"], unique=False)
    op.create_index(op.f("ix_token_metrics_token_id"), "token_metrics", ["token_id"], unique=False)
    op.create_index(op.f("ix_token_metrics_timestamp"), "token_metrics", ["timestamp"], unique=False)
    op.create_index("ix_token_metrics_token_timestamp", "token_metrics", ["token_id", "timestamp"], unique=False)
    op.create_index("ix_token_metrics_ath_usd", "token_metrics", ["ath_usd"], unique=False)

    op.create_table(
        "wallet_trades",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("wallet_id", sa.Integer(), sa.ForeignKey("wallets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_id", sa.Integer(), sa.ForeignKey("tokens.id", ondelete="CASCADE"), nullable=False),
        sa.Column("buy_timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sell_timestamp", sa.DateTime(timezone=True), nullable=True),
        sa.Column("amount_buy", sa.Float(), nullable=False, server_default=sa.text("0")),
        sa.Column("amount_sold", sa.Float(), nullable=False, server_default=sa.text("0")),
        sa.Column("avg_buy_price", sa.Float(), nullable=True),
        sa.Column("avg_sell_price", sa.Float(), nullable=True),
        sa.Column("realized_profit_usd", sa.Float(), nullable=True),
        sa.Column("still_holding", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("extra", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index(op.f("ix_wallet_trades_id"), "wallet_trades", ["id"], unique=False)
    op.create_index(op.f("ix_wallet_trades_wallet_id"), "wallet_trades", ["wallet_id"], unique=False)
    op.create_index(op.f("ix_wallet_trades_token_id"), "wallet_trades", ["token_id"], unique=False)
    op.create_index(op.f("ix_wallet_trades_buy_timestamp"), "wallet_trades", ["buy_timestamp"], unique=False)
    op.create_index("ix_wallet_trades_wallet_token", "wallet_trades", ["wallet_id", "token_id"], unique=False)
    op.create_index("ix_wallet_trades_profit", "wallet_trades", ["realized_profit_usd"], unique=False)

    op.create_table(
        "wallet_links",
        sa.Column("id", sa.Integer(), primary_key=True, nullable=False),
        sa.Column("wallet_a_id", sa.Integer(), sa.ForeignKey("wallets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("wallet_b_id", sa.Integer(), sa.ForeignKey("wallets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("shared_tokens_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("first_interaction_date", sa.DateTime(timezone=True), nullable=True),
        sa.Column("similarity_score", sa.Float(), nullable=False, server_default=sa.text("0")),
        sa.Column("details", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("wallet_a_id", "wallet_b_id", name="uq_wallet_links_pair"),
    )
    op.create_index(op.f("ix_wallet_links_id"), "wallet_links", ["id"], unique=False)
    op.create_index(op.f("ix_wallet_links_wallet_a_id"), "wallet_links", ["wallet_a_id"], unique=False)
    op.create_index(op.f("ix_wallet_links_wallet_b_id"), "wallet_links", ["wallet_b_id"], unique=False)
    op.create_index("ix_wallet_links_shared_tokens_count", "wallet_links", ["shared_tokens_count"], unique=False)
    op.create_index("ix_wallet_links_similarity_score", "wallet_links", ["similarity_score"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_wallet_links_similarity_score", table_name="wallet_links")
    op.drop_index("ix_wallet_links_shared_tokens_count", table_name="wallet_links")
    op.drop_index(op.f("ix_wallet_links_wallet_b_id"), table_name="wallet_links")
    op.drop_index(op.f("ix_wallet_links_wallet_a_id"), table_name="wallet_links")
    op.drop_index(op.f("ix_wallet_links_id"), table_name="wallet_links")
    op.drop_table("wallet_links")

    op.drop_index("ix_wallet_trades_profit", table_name="wallet_trades")
    op.drop_index("ix_wallet_trades_wallet_token", table_name="wallet_trades")
    op.drop_index(op.f("ix_wallet_trades_buy_timestamp"), table_name="wallet_trades")
    op.drop_index(op.f("ix_wallet_trades_token_id"), table_name="wallet_trades")
    op.drop_index(op.f("ix_wallet_trades_wallet_id"), table_name="wallet_trades")
    op.drop_index(op.f("ix_wallet_trades_id"), table_name="wallet_trades")
    op.drop_table("wallet_trades")

    op.drop_index("ix_token_metrics_ath_usd", table_name="token_metrics")
    op.drop_index("ix_token_metrics_token_timestamp", table_name="token_metrics")
    op.drop_index(op.f("ix_token_metrics_timestamp"), table_name="token_metrics")
    op.drop_index(op.f("ix_token_metrics_token_id"), table_name="token_metrics")
    op.drop_index(op.f("ix_token_metrics_id"), table_name="token_metrics")
    op.drop_table("token_metrics")

    op.drop_index(op.f("ix_collector_jobs_job_name"), table_name="collector_jobs")
    op.drop_index(op.f("ix_collector_jobs_id"), table_name="collector_jobs")
    op.drop_table("collector_jobs")

    op.drop_index(op.f("ix_wallets_wallet_address"), table_name="wallets")
    op.drop_index(op.f("ix_wallets_id"), table_name="wallets")
    op.drop_table("wallets")

    op.drop_index("ix_tokens_creator_wallet", table_name="tokens")
    op.drop_index("ix_tokens_status_migration_date", table_name="tokens")
    op.drop_index(op.f("ix_tokens_mint_address"), table_name="tokens")
    op.drop_index(op.f("ix_tokens_id"), table_name="tokens")
    op.drop_table("tokens")
