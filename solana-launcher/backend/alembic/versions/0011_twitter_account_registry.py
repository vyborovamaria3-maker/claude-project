"""add Twitter account intelligence registry"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0011_twitter_account_registry"
down_revision = "0010_advanced_intelligence"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "twitter_accounts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("twitter_id", sa.String(length=32), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=True),
        sa.Column("display_name", sa.String(length=255), nullable=True),
        sa.Column("bio", sa.Text(), nullable=False, server_default=""),
        sa.Column("avatar_url", sa.String(length=1024), nullable=True),
        sa.Column("followers_count", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("following_count", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("tweet_count", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("x_created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "account_type",
            sa.String(length=32),
            nullable=False,
            server_default="unknown",
        ),
        sa.Column("status", sa.String(length=24), nullable=False, server_default="active"),
        sa.Column(
            "first_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("last_profile_sync_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source", sa.String(length=64), nullable=False, server_default="unknown"),
        sa.Column("raw", sa.JSON(), nullable=True),
        sa.UniqueConstraint("twitter_id", name="uq_twitter_accounts_twitter_id"),
    )
    op.create_index("ix_twitter_accounts_username", "twitter_accounts", ["username"])
    op.create_index(
        "ix_twitter_accounts_type_status",
        "twitter_accounts",
        ["account_type", "status"],
    )
    op.create_index(
        "ix_twitter_accounts_last_seen",
        "twitter_accounts",
        ["last_seen_at"],
    )

    op.create_table(
        "twitter_account_snapshots",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "account_id",
            sa.Integer(),
            sa.ForeignKey("twitter_accounts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("followers_count", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("following_count", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("tweet_count", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column(
            "captured_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("source", sa.String(length=64), nullable=False, server_default="unknown"),
        sa.Column("raw", sa.JSON(), nullable=True),
    )
    op.create_index(
        "ix_twitter_account_snapshots_account_time",
        "twitter_account_snapshots",
        ["account_id", "captured_at"],
    )

    op.create_table(
        "twitter_account_scores",
        sa.Column(
            "account_id",
            sa.Integer(),
            sa.ForeignKey("twitter_accounts.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("influence_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("trust_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("alpha_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("shill_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column("bot_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column(
            "crypto_relevance_score",
            sa.Float(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "solana_relevance_score",
            sa.Float(),
            nullable=False,
            server_default="0",
        ),
        sa.Column("score_confidence", sa.Float(), nullable=False, server_default="0"),
        sa.Column(
            "score_source",
            sa.String(length=64),
            nullable=False,
            server_default="unknown",
        ),
        sa.Column("model_version", sa.String(length=128), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("meta", sa.JSON(), nullable=True),
    )
    op.create_index(
        "ix_twitter_account_scores_alpha",
        "twitter_account_scores",
        ["alpha_score"],
    )

    op.create_table(
        "twitter_posts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("twitter_post_id", sa.String(length=32), nullable=False),
        sa.Column(
            "account_id",
            sa.Integer(),
            sa.ForeignKey("twitter_accounts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("text", sa.Text(), nullable=False, server_default=""),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("likes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("replies", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("reposts", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("quotes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("views", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("language", sa.String(length=16), nullable=True),
        sa.Column("sentiment", sa.Float(), nullable=True),
        sa.Column("crypto_relevance", sa.Float(), nullable=True),
        sa.Column("spam_probability", sa.Float(), nullable=True),
        sa.Column("source_url", sa.String(length=512), nullable=True),
        sa.Column("source", sa.String(length=64), nullable=False, server_default="unknown"),
        sa.Column("raw", sa.JSON(), nullable=True),
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
        sa.UniqueConstraint(
            "twitter_post_id",
            name="uq_twitter_posts_twitter_post_id",
        ),
    )
    op.create_index(
        "ix_twitter_posts_account_published",
        "twitter_posts",
        ["account_id", "published_at"],
    )
    op.create_index("ix_twitter_posts_published", "twitter_posts", ["published_at"])

    op.create_table(
        "twitter_post_tokens",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "post_id",
            sa.Integer(),
            sa.ForeignKey("twitter_posts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "account_id",
            sa.Integer(),
            sa.ForeignKey("twitter_accounts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("mint_address", sa.String(length=64), nullable=False),
        sa.Column("symbol", sa.String(length=32), nullable=True),
        sa.Column(
            "mention_type",
            sa.String(length=24),
            nullable=False,
            server_default="mention",
        ),
        sa.Column("confidence", sa.Float(), nullable=False, server_default="1"),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("meta", sa.JSON(), nullable=True),
        sa.UniqueConstraint(
            "post_id",
            "mint_address",
            name="uq_twitter_post_tokens_post_mint",
        ),
    )
    op.create_index(
        "ix_twitter_post_tokens_mint_time",
        "twitter_post_tokens",
        ["mint_address", "first_seen_at"],
    )
    op.create_index(
        "ix_twitter_post_tokens_account_time",
        "twitter_post_tokens",
        ["account_id", "first_seen_at"],
    )

    op.create_table(
        "twitter_account_token_stats",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "account_id",
            sa.Integer(),
            sa.ForeignKey("twitter_accounts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("mint_address", sa.String(length=64), nullable=False),
        sa.Column("mentions_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("bullish_mentions", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("bearish_mentions", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("neutral_mentions", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("first_mention_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_mention_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("price_at_first_mention", sa.Float(), nullable=True),
        sa.Column("max_price_after_mention", sa.Float(), nullable=True),
        sa.Column("min_price_after_mention", sa.Float(), nullable=True),
        sa.Column("avg_return_1h", sa.Float(), nullable=True),
        sa.Column("avg_return_6h", sa.Float(), nullable=True),
        sa.Column("avg_return_24h", sa.Float(), nullable=True),
        sa.Column("avg_return_7d", sa.Float(), nullable=True),
        sa.Column("successful_calls", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("failed_calls", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("token_alpha_score", sa.Float(), nullable=False, server_default="0"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("meta", sa.JSON(), nullable=True),
        sa.UniqueConstraint(
            "account_id",
            "mint_address",
            name="uq_twitter_account_token_stats_account_mint",
        ),
    )
    op.create_index(
        "ix_twitter_account_token_stats_mint_alpha",
        "twitter_account_token_stats",
        ["mint_address", "token_alpha_score"],
    )
    op.create_index(
        "ix_twitter_account_token_stats_account_updated",
        "twitter_account_token_stats",
        ["account_id", "updated_at"],
    )


def downgrade() -> None:
    op.drop_table("twitter_account_token_stats")
    op.drop_table("twitter_post_tokens")
    op.drop_table("twitter_posts")
    op.drop_table("twitter_account_scores")
    op.drop_table("twitter_account_snapshots")
    op.drop_table("twitter_accounts")
