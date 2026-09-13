from app.admin_twitter import (
    TWITTER_ADMIN_VIEWS,
    TwitterAccountAdmin,
    TwitterCrawlerRunAdmin,
    TwitterDiscoveryCandidateAdmin,
)
from app.models.twitter_crawler_run import TwitterCrawlerRun
from app.models.twitter_discovery_scoring import TwitterDiscoveryScore
from app.models.twitter_intelligence import (
    TwitterAccount,
    TwitterAccountScore,
    TwitterAccountSnapshot,
    TwitterAccountTokenStat,
    TwitterDiscoveryCandidate,
    TwitterDiscoveryEvidence,
    TwitterPost,
)


def test_twitter_admin_registers_monitoring_tables():
    registered_models = {view.model for view in TWITTER_ADMIN_VIEWS}
    assert registered_models == {
        TwitterCrawlerRun,
        TwitterDiscoveryCandidate,
        TwitterAccount,
        TwitterDiscoveryEvidence,
        TwitterDiscoveryScore,
        TwitterPost,
        TwitterAccountSnapshot,
        TwitterAccountScore,
        TwitterAccountTokenStat,
    }


def test_crawler_run_view_is_read_only_and_shows_health_fields():
    assert TwitterCrawlerRunAdmin.can_create is False
    assert TwitterCrawlerRunAdmin.can_edit is False
    assert TwitterCrawlerRunAdmin.can_delete is False
    assert {
        "status",
        "phase",
        "worker",
        "heartbeat_at",
        "finished_at",
        "duration_ms",
        "error",
    }.issubset(set(TwitterCrawlerRunAdmin.column_list))


def test_candidate_admin_only_edits_operational_queue_fields():
    assert TwitterDiscoveryCandidateAdmin.can_create is False
    assert TwitterDiscoveryCandidateAdmin.can_delete is False
    assert TwitterDiscoveryCandidateAdmin.can_edit is True
    assert TwitterDiscoveryCandidateAdmin.form_columns == [
        "account_type_hint",
        "status",
        "priority",
        "relevance_hint",
        "next_attempt_at",
    ]


def test_account_admin_only_edits_classification_fields():
    assert TwitterAccountAdmin.can_create is False
    assert TwitterAccountAdmin.can_delete is False
    assert TwitterAccountAdmin.can_edit is True
    assert TwitterAccountAdmin.form_columns == ["account_type", "status"]
