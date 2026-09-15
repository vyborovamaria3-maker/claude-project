from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.v1.kols_internal import _require_kol_internal_key
from app.tasks import kols as kol_tasks


class _FakeLock:
    def __init__(self, *, acquired: bool):
        self.acquired = acquired
        self.released = False

    def acquire(self, *, blocking: bool = False) -> bool:
        assert blocking is False
        return self.acquired

    def release(self) -> None:
        self.released = True


class _FakeRedis:
    def __init__(self, lock: _FakeLock):
        self._lock = lock
        self.closed = False

    def lock(self, *_args, **_kwargs) -> _FakeLock:
        return self._lock

    def close(self) -> None:
        self.closed = True


def _request(*, environment: str, backend_key: str):
    settings = SimpleNamespace(environment=environment, backend_api_key=backend_key)
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(settings=settings)))


def test_production_kol_key_rejects_short_secret(monkeypatch):
    monkeypatch.setenv("KOL_INTERNAL_KEY", "short")
    request = _request(environment="production", backend_key="b" * 40)

    with pytest.raises(HTTPException) as exc:
        _require_kol_internal_key(request, "short")

    assert exc.value.status_code == 503


def test_production_kol_key_must_differ_from_backend_master(monkeypatch):
    shared = "x" * 40
    monkeypatch.setenv("KOL_INTERNAL_KEY", shared)
    request = _request(environment="production", backend_key=shared)

    with pytest.raises(HTTPException) as exc:
        _require_kol_internal_key(request, shared)

    assert exc.value.status_code == 503


def test_production_kol_key_accepts_distinct_strong_secret(monkeypatch):
    scoped = "k" * 40
    monkeypatch.setenv("KOL_INTERNAL_KEY", scoped)
    request = _request(environment="production", backend_key="b" * 40)

    _require_kol_internal_key(request, scoped)


def test_refresh_metrics_skips_when_distributed_lock_is_held(monkeypatch):
    lock = _FakeLock(acquired=False)
    redis = _FakeRedis(lock)
    monkeypatch.setattr(kol_tasks.Redis, "from_url", lambda *_args, **_kwargs: redis)

    async def must_not_run():
        raise AssertionError("refresh body must not run without the distributed lock")

    monkeypatch.setattr(kol_tasks, "_run_refresh", must_not_run)
    result = kol_tasks.refresh_metrics.run()

    assert result == {"wallets": 0, "metrics": 0, "skipped": 1}
    assert lock.released is False
    assert redis.closed is True


def test_refresh_metrics_releases_lock_after_success(monkeypatch):
    lock = _FakeLock(acquired=True)
    redis = _FakeRedis(lock)
    monkeypatch.setattr(kol_tasks.Redis, "from_url", lambda *_args, **_kwargs: redis)

    async def fake_refresh():
        return {"wallets": 2, "metrics": 6}

    monkeypatch.setattr(kol_tasks, "_run_refresh", fake_refresh)
    result = kol_tasks.refresh_metrics.run()

    assert result == {"wallets": 2, "metrics": 6}
    assert lock.released is True
    assert redis.closed is True
