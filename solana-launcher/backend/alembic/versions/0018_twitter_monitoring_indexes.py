"""add indexes used by Twitter monitoring dashboards"""

from __future__ import annotations

from alembic import op

revision = "0018_twitter_monitoring_indexes"
down_revision = "0017_twitter_public_defaults"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_twitter_accounts_first_seen",
        "twitter_accounts",
        ["first_seen_at"],
    )
    op.create_index(
        "ix_twitter_discovery_candidates_first_seen",
        "twitter_discovery_candidates",
        ["first_seen_at"],
    )
    op.create_index(
        "ix_twitter_crawler_runs_status_started",
        "twitter_crawler_runs",
        ["status", "started_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_twitter_crawler_runs_status_started",
        table_name="twitter_crawler_runs",
    )
    op.drop_index(
        "ix_twitter_discovery_candidates_first_seen",
        table_name="twitter_discovery_candidates",
    )
    op.drop_index(
        "ix_twitter_accounts_first_seen",
        table_name="twitter_accounts",
    )
