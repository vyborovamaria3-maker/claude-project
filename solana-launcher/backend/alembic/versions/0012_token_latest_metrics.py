"""add token latest metrics hot table"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0012_token_latest_metrics"
down_revision = "0011_analytics_hot_path_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "token_latest_metrics",
        sa.Column(
            "token_id",
            sa.Integer(),
            sa.ForeignKey("tokens.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column("metric_id", sa.Integer(), nullable=False, unique=True),
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
    op.create_index(
        "ix_token_latest_metrics_metric_id",
        "token_latest_metrics",
        ["metric_id"],
        unique=True,
    )
    op.create_index(
        "ix_token_latest_metrics_timestamp",
        "token_latest_metrics",
        ["timestamp"],
        unique=False,
    )
    for column in ("ath_usd", "volume_24h", "liquidity_usd", "market_cap", "holder_count"):
        op.create_index(
            f"ix_token_latest_metrics_{column}",
            "token_latest_metrics",
            [column],
            unique=False,
        )

    op.execute(
        """
        INSERT INTO token_latest_metrics (
            token_id,
            metric_id,
            timestamp,
            price_usd,
            ath_usd,
            ath_date,
            market_cap,
            fdv,
            liquidity_usd,
            volume_24h,
            tx_count_24h,
            holder_count,
            twitter_url,
            telegram_url,
            discord_url,
            website_url,
            social_engagements
        )
        SELECT
            token_id,
            id,
            timestamp,
            price_usd,
            ath_usd,
            ath_date,
            market_cap,
            fdv,
            liquidity_usd,
            volume_24h,
            tx_count_24h,
            holder_count,
            twitter_url,
            telegram_url,
            discord_url,
            website_url,
            social_engagements
        FROM (
            SELECT
                token_metrics.*,
                ROW_NUMBER() OVER (
                    PARTITION BY token_id
                    ORDER BY timestamp DESC, id DESC
                ) AS rn
            FROM token_metrics
        ) ranked
        WHERE rn = 1
        """
    )


def downgrade() -> None:
    for column in ("holder_count", "market_cap", "liquidity_usd", "volume_24h", "ath_usd"):
        op.drop_index(
            f"ix_token_latest_metrics_{column}",
            table_name="token_latest_metrics",
        )
    op.drop_index(
        "ix_token_latest_metrics_timestamp",
        table_name="token_latest_metrics",
    )
    op.drop_index(
        "ix_token_latest_metrics_metric_id",
        table_name="token_latest_metrics",
    )
    op.drop_table("token_latest_metrics")
