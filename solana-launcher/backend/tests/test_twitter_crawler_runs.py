from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.services import twitter_crawler_runs as runs


class _ScalarRows:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return list(self._rows)


class _ExecuteResult:
    def __init__(self, rows=None, *, rowcount=0):
        self._rows = rows or []
        self.rowcount = rowcount

    def scalars(self):
        return _ScalarRows(self._rows)


class _ExpireSession:
    def __init__(self, rows):
        self.rows = rows

    async def execute(self, _statement):
        return _ExecuteResult(self.rows)


@pytest.mark.asyncio
async def test_expire_stale_runs_marks_old_running_rows_failed():
    now = datetime(2026, 9, 13, 12, 0, tzinfo=timezone.utc)
    row = SimpleNamespace(
        status="running",
        phase="frontier",
        started_at=now - timedelta(hours=3),
        finished_at=None,
        duration_ms=None,
        error=None,
    )

    count = await runs._expire_stale_runs(
        _ExpireSession([row]),
        job_name="twitter_discovery_cycle",
        now=now,
    )

    assert count == 1
    assert row.status == "failed"
    assert row.phase == "stale"
    assert row.finished_at == now
    assert row.duration_ms == 3 * 60 * 60 * 1000
    assert "heartbeat expired" in row.error


class _Engine:
    def __init__(self):
        self.disposed = False

    async def dispose(self):
        self.disposed = True


class _Session:
    def __init__(self, row, *, update_rowcount=1):
        self.row = row
        self.update_rowcount = update_rowcount
        self.committed = False
        self.rolled_back = False
        self.execute_calls = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, _exc_type, _exc, _tb):
        return False

    async def get(self, _model, _run_id):
        return self.row

    async def execute(self, _statement):
        self.execute_calls += 1
        return _ExecuteResult(rowcount=self.update_rowcount)

    async def commit(self):
        self.committed = True

    async def rollback(self):
        self.rolled_back = True


@pytest.mark.asyncio
async def test_finish_does_not_overwrite_terminal_status(monkeypatch):
    now = datetime.now(timezone.utc)
    row = SimpleNamespace(
        status="cancelled",
        phase="cancelled",
        started_at=now - timedelta(seconds=10),
        heartbeat_at=now,
        finished_at=now,
        duration_ms=10_000,
        error="cancelled",
        summary={"old": True},
    )
    engine = _Engine()
    session = _Session(row)

    monkeypatch.setattr(runs, "get_settings", lambda: object())
    monkeypatch.setattr(
        runs,
        "create_engine_and_sessionmaker",
        lambda _settings: (engine, lambda: session),
    )

    await runs.finish_twitter_crawler_run(
        7,
        status="success",
        phase="complete",
        summary={"new": True},
    )

    assert session.execute_calls == 0
    assert session.committed is False
    assert session.rolled_back is False
    assert engine.disposed is True


@pytest.mark.asyncio
async def test_finish_commits_atomic_update_for_running_status(monkeypatch):
    started = datetime.now(timezone.utc) - timedelta(seconds=2)
    row = SimpleNamespace(status="running", started_at=started)
    engine = _Engine()
    session = _Session(row, update_rowcount=1)

    monkeypatch.setattr(runs, "get_settings", lambda: object())
    monkeypatch.setattr(
        runs,
        "create_engine_and_sessionmaker",
        lambda _settings: (engine, lambda: session),
    )

    await runs.finish_twitter_crawler_run(
        8,
        status="success",
        phase="complete",
        summary={"ok": True},
    )

    assert session.execute_calls == 1
    assert session.committed is True
    assert session.rolled_back is False
    assert engine.disposed is True


@pytest.mark.asyncio
async def test_finish_loses_race_without_overwriting_terminal_status(monkeypatch):
    started = datetime.now(timezone.utc) - timedelta(seconds=2)
    row = SimpleNamespace(status="running", started_at=started)
    engine = _Engine()
    # Simulate another transaction moving the row out of running after our read.
    session = _Session(row, update_rowcount=0)

    monkeypatch.setattr(runs, "get_settings", lambda: object())
    monkeypatch.setattr(
        runs,
        "create_engine_and_sessionmaker",
        lambda _settings: (engine, lambda: session),
    )

    await runs.finish_twitter_crawler_run(
        9,
        status="success",
        phase="complete",
        summary={"late": True},
    )

    assert session.execute_calls == 1
    assert session.committed is False
    assert session.rolled_back is True
    assert engine.disposed is True
