from app.cli.twitter_discovery_cycle import cycle_result_is_degraded, frontier_was_processed


def test_cycle_health_is_success_without_partial_failures():
    result = {
        "ingest": {
            "public_web_errors": [],
            "x_search_errors": [],
            "x_search_rate_limited": False,
        },
        "frontier": {"frontier": {"failed": 0, "rate_limited": 0}},
    }
    assert cycle_result_is_degraded(result) is False


def test_cycle_health_is_degraded_on_search_error():
    result = {
        "ingest": {
            "public_web_errors": [],
            "x_search_errors": ["temporary X search failure"],
        },
        "frontier": None,
    }
    assert cycle_result_is_degraded(result) is True


def test_cycle_health_is_degraded_on_rate_limit_or_frontier_failure():
    rate_limited = {
        "ingest": {"x_search_rate_limited": True},
        "frontier": None,
    }
    frontier_failed = {
        "ingest": {},
        "frontier": {"frontier": {"failed": 2, "rate_limited": 0}},
    }
    assert cycle_result_is_degraded(rate_limited) is True
    assert cycle_result_is_degraded(frontier_failed) is True


def test_frontier_processed_requires_actual_frontier_counters():
    assert frontier_was_processed(None) is False
    assert frontier_was_processed({"frontier_skipped": "X API not configured"}) is False
    assert frontier_was_processed({"frontier": None}) is False
    assert frontier_was_processed({"frontier": {"processed": 0}}) is True
