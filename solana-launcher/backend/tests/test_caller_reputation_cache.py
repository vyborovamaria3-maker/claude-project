from __future__ import annotations

from app.services import caller_reputation_cache as cache_service


async def test_top_callers_cache_hit_skips_database_rebuild(monkeypatch) -> None:
    async def fake_read():
        return [
            {"username": "alpha", "reputation_score": 90.0},
            {"username": "beta", "reputation_score": 80.0},
        ]

    async def should_not_run(*_args, **_kwargs):
        raise AssertionError("cold caller reputation path should not execute")

    monkeypatch.setattr(cache_service, "_safe_read", fake_read)
    monkeypatch.setattr(cache_service, "caller_reputation", should_not_run)

    rows = await cache_service.cached_top_callers(object(), limit=1)
    assert rows == [{"username": "alpha", "reputation_score": 90.0}]


async def test_top_callers_cache_failure_degrades_to_database(monkeypatch) -> None:
    async def fake_read():
        return None

    def redis_unavailable():
        raise RuntimeError("redis unavailable")

    async def fake_reputation(_session, *, limit):
        assert limit == 250
        return [{"username": "alpha", "reputation_score": 91.0}]

    async def cache_unavailable(*_args, **_kwargs):
        raise RuntimeError("redis unavailable")

    monkeypatch.setattr(cache_service, "_safe_read", fake_read)
    monkeypatch.setattr(cache_service, "get_redis_client", redis_unavailable)
    monkeypatch.setattr(cache_service, "caller_reputation", fake_reputation)
    monkeypatch.setattr(cache_service, "cache_json", cache_unavailable)

    rows = await cache_service.cached_top_callers(object(), limit=50)
    assert rows == [{"username": "alpha", "reputation_score": 91.0}]
