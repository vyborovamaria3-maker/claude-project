from __future__ import annotations

from app.models.twitter_crawler_settings import TwitterCrawlerSettings
from sqlalchemy import CheckConstraint

EXPECTED_CHECKS = {
    "ck_twitter_crawler_settings_singleton",
    "ck_twitter_crawler_settings_query_limit",
    "ck_twitter_crawler_settings_cycle_limits",
    "ck_twitter_crawler_settings_relevance",
    "ck_twitter_crawler_settings_network_mode",
    "ck_twitter_crawler_settings_worker_limits",
    "ck_twitter_crawler_settings_public_limits",
}


def test_twitter_settings_model_declares_database_invariants():
    checks = {
        constraint.name
        for constraint in TwitterCrawlerSettings.__table__.constraints
        if isinstance(constraint, CheckConstraint)
    }
    assert EXPECTED_CHECKS.issubset(checks)
