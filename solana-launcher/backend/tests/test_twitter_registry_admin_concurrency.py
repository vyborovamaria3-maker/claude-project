from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.base import Base
from app.models.twitter_discovery_admin import TwitterDiscoveryRun, TwitterDiscoveryRunLock
from app.services.twitter_discovery_admin_runtime import (
    DiscoveryRunBusy,
    finish_discovery_run,
    recover_stale_discovery_runs,
    start_discovery_run,
)


@pytest.mark.asyncio
async def test_discovery_run_claim_is_atomic_under_real_concurrency(tmp_path):
    database = tmp_path / "twitter-run-lock.sqlite3"
    engine = create_async_engine(f"sqlite+aiosqlite:///{database}")
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    gate = asyncio.Event()

    async def claim(worker_id: str):
        await gate.wait()
        async with sessionmaker() as session:
            try:
                context = await start_discovery_run(
                    session,
                    mode="public_no_x_api",
                    trigger="concurrency_test",
                    worker_id=worker_id,
                    config_snapshot={},
                )
                return ("claimed", context)
            except DiscoveryRunBusy:
                return ("busy", None)

    first_task = asyncio.create_task(claim("worker-a"))
    second_task = asyncio.create_task(claim("worker-b"))
    gate.set()
    results = await asyncio.gather(first_task, second_task)

    claimed = [context for result, context in results if result == "claimed"]
    busy = [result for result, _context in results if result == "busy"]
    assert len(claimed) == 1
    assert len(busy) == 1

    async with sessionmaker() as session:
        await finish_discovery_run(session, claimed[0], status="completed", summary={})
    await engine.dispose()


@pytest.mark.asyncio
async def test_expired_lock_recovers_failed_run_and_allows_new_claim(tmp_path):
    database = tmp_path / "twitter-stale-lock.sqlite3"
    engine = create_async_engine(f"sqlite+aiosqlite:///{database}")
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with sessionmaker() as session:
        stale = TwitterDiscoveryRun(
            status="running",
            worker_id="dead-worker",
            mode="public_no_x_api",
            trigger="test",
        )
        session.add(stale)
        await session.flush()
        session.add(
            TwitterDiscoveryRunLock(
                lock_key="twitter-discovery",
                owner_token="dead-owner",
                run_id=stale.id,
                lease_expires_at=datetime.now(UTC) - timedelta(seconds=1),
            )
        )
        await session.commit()
        stale_id = stale.id

    async with sessionmaker() as session:
        recovered = await recover_stale_discovery_runs(session)
        assert recovered >= 1
        stale = await session.get(TwitterDiscoveryRun, stale_id)
        assert stale is not None
        assert stale.status == "failed"
        assert stale.finished_at is not None

    async with sessionmaker() as session:
        next_run = await start_discovery_run(
            session,
            mode="public_no_x_api",
            trigger="after_recovery",
            worker_id="worker-new",
            config_snapshot={},
        )
        assert next_run.worker_id == "worker-new"
        await finish_discovery_run(session, next_run, status="completed", summary={})

    await engine.dispose()
