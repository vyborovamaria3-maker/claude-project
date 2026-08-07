"""add Telegram and cross-platform social intelligence tables"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0007_telegram_intelligence"
down_revision = ("0006_merge_0004_heads", "0005_user_roles")
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "telegram_channels",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("telegram_id", sa.BigInteger(), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("entity_type", sa.String(length=24), nullable=False, server_default="channel"),
        sa.Column("participants", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("about", sa.Text(), nullable=False, server_default=""),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_scanned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("meta", sa.JSON(), nullable=True),
        sa.UniqueConstraint("telegram_id", name="uq_telegram_channels_telegram_id"),
    )
    op.create_index("ix_telegram_channels_username", "telegram_channels", ["username"])
    op.create_index("ix_telegram_channels_participants", "telegram_channels", ["participants"])

    op.create_table(
        "telegram_users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("telegram_id", sa.BigInteger(), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=True),
        sa.Column("display_name", sa.String(length=255), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("meta", sa.JSON(), nullable=True),
        sa.UniqueConstraint("telegram_id", name="uq_telegram_users_telegram_id"),
    )
    op.create_index("ix_telegram_users_username", "telegram_users", ["username"])

    op.create_table(
        "telegram_messages",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("channel_id", sa.Integer(), sa.ForeignKey("telegram_channels.id", ondelete="CASCADE"), nullable=False),
        sa.Column("telegram_message_id", sa.BigInteger(), nullable=False),
        sa.Column("sender_id", sa.Integer(), sa.ForeignKey("telegram_users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("sender_telegram_id", sa.BigInteger(), nullable=True),
        sa.Column("sender_username", sa.String(length=64), nullable=True),
        sa.Column("sender_name", sa.String(length=255), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("text", sa.Text(), nullable=False, server_default=""),
        sa.Column("views", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("forwards", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("replies", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reactions", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("raw", sa.JSON(), nullable=True),
        sa.UniqueConstraint("channel_id", "telegram_message_id", name="uq_telegram_messages_channel_message"),
    )
    op.create_index("ix_telegram_messages_channel_date", "telegram_messages", ["channel_id", "published_at"])
    op.create_index("ix_telegram_messages_sender", "telegram_messages", ["sender_telegram_id", "published_at"])

    op.create_table(
        "telegram_token_mentions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("message_id", sa.Integer(), sa.ForeignKey("telegram_messages.id", ondelete="CASCADE"), nullable=False),
        sa.Column("channel_id", sa.Integer(), sa.ForeignKey("telegram_channels.id", ondelete="CASCADE"), nullable=False),
        sa.Column("mint_address", sa.String(length=64), nullable=False),
        sa.Column("ticker", sa.String(length=32), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_url", sa.String(length=512), nullable=True),
        sa.Column("is_explicit_call", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.UniqueConstraint("message_id", "mint_address", name="uq_telegram_token_mentions_message_mint"),
    )
    op.create_index("ix_telegram_token_mentions_mint_date", "telegram_token_mentions", ["mint_address", "first_seen_at"])
    op.create_index("ix_telegram_token_mentions_channel", "telegram_token_mentions", ["channel_id", "first_seen_at"])

    op.create_table(
        "telegram_calls",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("mention_id", sa.Integer(), sa.ForeignKey("telegram_token_mentions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("channel_id", sa.Integer(), sa.ForeignKey("telegram_channels.id", ondelete="CASCADE"), nullable=False),
        sa.Column("message_id", sa.Integer(), sa.ForeignKey("telegram_messages.id", ondelete="CASCADE"), nullable=False),
        sa.Column("mint_address", sa.String(length=64), nullable=False),
        sa.Column("caller_telegram_id", sa.BigInteger(), nullable=True),
        sa.Column("caller_username", sa.String(length=64), nullable=True),
        sa.Column("called_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("is_explicit_call", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("call_price_usd", sa.Float(), nullable=True),
        sa.Column("call_market_cap_usd", sa.Float(), nullable=True),
        sa.Column("peak_price_usd", sa.Float(), nullable=True),
        sa.Column("peak_market_cap_usd", sa.Float(), nullable=True),
        sa.Column("roi_multiple", sa.Float(), nullable=True),
        sa.Column("outcome", sa.String(length=24), nullable=False, server_default="pending"),
        sa.Column("evaluated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("meta", sa.JSON(), nullable=True),
        sa.UniqueConstraint("mention_id", name="uq_telegram_calls_mention"),
    )
    op.create_index("ix_telegram_calls_mint_called", "telegram_calls", ["mint_address", "called_at"])
    op.create_index("ix_telegram_calls_channel_called", "telegram_calls", ["channel_id", "called_at"])
    op.create_index("ix_telegram_calls_caller", "telegram_calls", ["caller_username", "called_at"])
    op.create_index("ix_telegram_calls_outcome", "telegram_calls", ["outcome"])

    op.create_table(
        "telegram_channel_scores",
        sa.Column("channel_id", sa.Integer(), sa.ForeignKey("telegram_channels.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("calls_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("evaluated_calls", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("successful_calls", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rug_calls", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("early_calls", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("win_rate", sa.Float(), nullable=False, server_default="0"),
        sa.Column("rug_rate", sa.Float(), nullable=False, server_default="0"),
        sa.Column("avg_roi", sa.Float(), nullable=False, server_default="0"),
        sa.Column("score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "social_relations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("source_platform", sa.String(length=24), nullable=False),
        sa.Column("source_handle", sa.String(length=128), nullable=False),
        sa.Column("target_platform", sa.String(length=24), nullable=False),
        sa.Column("target_handle", sa.String(length=128), nullable=False),
        sa.Column("relation_type", sa.String(length=32), nullable=False, server_default="mention"),
        sa.Column("count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("evidence", sa.Text(), nullable=False, server_default=""),
        sa.UniqueConstraint(
            "source_platform",
            "source_handle",
            "target_platform",
            "target_handle",
            "relation_type",
            name="uq_social_relations_edge",
        ),
    )
    op.create_index("ix_social_relations_source", "social_relations", ["source_platform", "source_handle"])
    op.create_index("ix_social_relations_target", "social_relations", ["target_platform", "target_handle"])

    op.create_table(
        "social_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("platform", sa.String(length=24), nullable=False),
        sa.Column("event_type", sa.String(length=32), nullable=False, server_default="token_mention"),
        sa.Column("external_id", sa.String(length=128), nullable=False),
        sa.Column("source_handle", sa.String(length=128), nullable=True),
        sa.Column("source_name", sa.String(length=255), nullable=True),
        sa.Column("source_url", sa.String(length=512), nullable=True),
        sa.Column("mint_address", sa.String(length=64), nullable=True),
        sa.Column("symbol", sa.String(length=32), nullable=True),
        sa.Column("text", sa.Text(), nullable=False, server_default=""),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("metrics", sa.JSON(), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("platform", "event_type", "external_id", "mint_address", name="uq_social_events_external_mint"),
    )
    op.create_index("ix_social_events_mint_time", "social_events", ["mint_address", "occurred_at"])
    op.create_index("ix_social_events_platform_time", "social_events", ["platform", "occurred_at"])
    op.create_index("ix_social_events_source", "social_events", ["source_handle", "occurred_at"])


def downgrade() -> None:
    op.drop_index("ix_social_events_source", table_name="social_events")
    op.drop_index("ix_social_events_platform_time", table_name="social_events")
    op.drop_index("ix_social_events_mint_time", table_name="social_events")
    op.drop_table("social_events")
    op.drop_index("ix_social_relations_target", table_name="social_relations")
    op.drop_index("ix_social_relations_source", table_name="social_relations")
    op.drop_table("social_relations")
    op.drop_table("telegram_channel_scores")
    op.drop_index("ix_telegram_calls_outcome", table_name="telegram_calls")
    op.drop_index("ix_telegram_calls_caller", table_name="telegram_calls")
    op.drop_index("ix_telegram_calls_channel_called", table_name="telegram_calls")
    op.drop_index("ix_telegram_calls_mint_called", table_name="telegram_calls")
    op.drop_table("telegram_calls")
    op.drop_index("ix_telegram_token_mentions_channel", table_name="telegram_token_mentions")
    op.drop_index("ix_telegram_token_mentions_mint_date", table_name="telegram_token_mentions")
    op.drop_table("telegram_token_mentions")
    op.drop_index("ix_telegram_messages_sender", table_name="telegram_messages")
    op.drop_index("ix_telegram_messages_channel_date", table_name="telegram_messages")
    op.drop_table("telegram_messages")
    op.drop_index("ix_telegram_users_username", table_name="telegram_users")
    op.drop_table("telegram_users")
    op.drop_index("ix_telegram_channels_participants", table_name="telegram_channels")
    op.drop_index("ix_telegram_channels_username", table_name="telegram_channels")
    op.drop_table("telegram_channels")
