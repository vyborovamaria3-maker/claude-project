from types import SimpleNamespace

import pytest

from app.cli import twitter_discovery_cycle as cycle
from app.cli import twitter_discovery_public as public
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


@pytest.mark.asyncio
async def test_cycle_does_not_execute_when_active_run_is_already_held(monkeypatch):
    args = SimpleNamespace(
        dry_run=False,
        skip_frontier=False,
        skip_rescore=False,
        query_limit=50,
        process_limit=250,
        batch_size=25,
        max_depth=2,
        min_relevance=35.0,
        network_mode="following",
        network_limit=100,
        lease_seconds=300,
        rescore_limit=1500,
    )
    executed = False

    async def no_claim(*_args, **_kwargs):
        return None

    async def should_not_run(*_args, **_kwargs):
        nonlocal executed
        executed = True
        raise AssertionError("duplicate cycle must not execute")

    monkeypatch.setattr(cycle, "try_start_twitter_crawler_run", no_claim)
    monkeypatch.setattr(cycle, "run", should_not_run)

    result = await cycle.run_tracked(args)

    assert result == {"skipped": True, "reason": "already_running"}
    assert executed is False


@pytest.mark.asyncio
async def test_public_discovery_does_not_execute_when_active_run_is_already_held(monkeypatch):
    args = SimpleNamespace(
        dexscreener_latest=True,
        dexscreener_boosts=True,
        db_solana_tokens=500,
        cmc_limit=0,
        rescore_limit=3000,
        dry_run=False,
    )
    executed = False

    async def no_claim(*_args, **_kwargs):
        return None

    async def should_not_run(*_args, **_kwargs):
        nonlocal executed
        executed = True
        raise AssertionError("duplicate public discovery must not execute")

    monkeypatch.setattr(public, "try_start_twitter_crawler_run", no_claim)
    monkeypatch.setattr(public, "run", should_not_run)

    result = await public.run_tracked(args)

    assert result == {"skipped": True, "reason": "already_running"}
    assert executed is False
