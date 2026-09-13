"""enforce Twitter crawler settings invariants in the database"""

from __future__ import annotations

from alembic import op

revision = "0019_twitter_settings_checks"
down_revision = "0018_twitter_monitoring_indexes"
branch_labels = None
depends_on = None


CONSTRAINTS = (
    ("ck_twitter_crawler_settings_singleton", "id = 1"),
    ("ck_twitter_crawler_settings_query_limit", "query_limit BETWEEN 10 AND 100"),
    (
        "ck_twitter_crawler_settings_cycle_limits",
        "process_limit BETWEEN 1 AND 5000 AND batch_size BETWEEN 1 AND 250 "
        "AND max_depth BETWEEN 0 AND 8",
    ),
    (
        "ck_twitter_crawler_settings_relevance",
        "min_relevance >= 0 AND min_relevance <= 100",
    ),
    (
        "ck_twitter_crawler_settings_network_mode",
        "network_mode IN ('none','following','followers','both')",
    ),
    (
        "ck_twitter_crawler_settings_worker_limits",
        "network_limit BETWEEN 1 AND 1000 AND lease_seconds BETWEEN 30 AND 3600 "
        "AND rescore_limit BETWEEN 1 AND 5000",
    ),
    (
        "ck_twitter_crawler_settings_public_limits",
        "public_db_solana_tokens BETWEEN 0 AND 10000 "
        "AND public_cmc_limit BETWEEN 0 AND 5000 "
        "AND public_rescore_limit BETWEEN 0 AND 5000",
    ),
)


def upgrade() -> None:
    for name, expression in CONSTRAINTS:
        op.create_check_constraint(name, "twitter_crawler_settings", expression)


def downgrade() -> None:
    for name, _expression in reversed(CONSTRAINTS):
        op.drop_constraint(name, "twitter_crawler_settings", type_="check")
