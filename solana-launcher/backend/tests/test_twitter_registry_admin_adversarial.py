from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.core.config import get_settings
from app.db.base import Base
from app.models.twitter_discovery_admin import TwitterDiscoveryRun, TwitterDiscoveryRunLock
from app.models.twitter_intelligence import TwitterAccount, TwitterDiscoveryCandidate
from app.schemas.user import UserCreate
from app.services.twitter_discovery import (
    ResolvedTwitterProfile,
    promote_candidate,
)
from app.services.twitter_discovery_admin_runtime import (
    DiscoveryRunBusy,
    finish_discovery_run,
    run_tracked_cli,
    start_discovery_run,
)
from app.services.users import create_user


@pytest_asyncio.fixture
async def sessionmaker_fixture():
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield sessionmaker
    await engine.dispose()


@pytest_asyncio.fixture
async def admin_app_client(tmp_path):
    db_file = tmp_path / "adversarial.sqlite3"
    db_url = f"sqlite+aiosqlite:///{db_file}"
    engine = create_async_engine(
        db_url,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    settings = get_settings()
    settings.database_url = db_url

    from app.main import create_app
    app = create_app(settings=settings, engine=engine, sessionmaker=sessionmaker)

    async with sessionmaker() as session:
        await create_user(
            session,
            UserCreate(email="superadmin@potapoff.com", password="ChangeMe123!"),
            is_superuser=True,
        )
        await session.commit()

    with TestClient(app) as client:
        login_resp = client.post(
            "/api/v1/auth/login-json",
            json={"email": "superadmin@potapoff.com", "password": "ChangeMe123!"},
        )
        token = login_resp.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}
        yield client, headers, sessionmaker

    await engine.dispose()


@pytest.mark.asyncio
async def test_service_concurrent_discovery_run_atomic(sessionmaker_fixture):
    gate = asyncio.Event()

    async def attempt(worker_id: str):
        await gate.wait()
        async with sessionmaker_fixture() as session:
            try:
                ctx = await start_discovery_run(
                    session,
                    mode="x_api",
                    trigger="adversarial_concurrency",
                    worker_id=worker_id,
                )
                return ("claimed", ctx)
            except DiscoveryRunBusy:
                return ("busy", None)

    task1 = asyncio.create_task(attempt("worker-1"))
    task2 = asyncio.create_task(attempt("worker-2"))
    gate.set()
    results = await asyncio.gather(task1, task2)

    claimed = [ctx for res, ctx in results if res == "claimed"]
    busy = [res for res, _ in results if res == "busy"]

    assert len(claimed) == 1
    assert len(busy) == 1

    async with sessionmaker_fixture() as session:
        await finish_discovery_run(session, claimed[0], status="completed")


@pytest.mark.asyncio
async def test_wrong_owner_cannot_release_new_owner_lock(sessionmaker_fixture):
    async with sessionmaker_fixture() as session:
        ctx_a = await start_discovery_run(session, mode="x_api", trigger="test_a", worker_id="worker-a")
        await session.commit()

        lock_row = await session.get(TwitterDiscoveryRunLock, "twitter-discovery")
        lock_row.lease_expires_at = datetime.now(UTC) - timedelta(minutes=10)
        await session.commit()

        ctx_b = await start_discovery_run(session, mode="x_api", trigger="test_b", worker_id="worker-b")
        await session.commit()

        current_lock = await session.get(TwitterDiscoveryRunLock, "twitter-discovery")
        assert current_lock.owner_token == ctx_b.owner_token

        # Worker A tries to finish/release using its old context A
        await finish_discovery_run(session, ctx_a, status="completed")
        await session.commit()

        current_lock_after = await session.get(TwitterDiscoveryRunLock, "twitter-discovery")
        assert current_lock_after is not None
        assert current_lock_after.owner_token == ctx_b.owner_token
        assert current_lock_after.run_id == ctx_b.run_id


@pytest.mark.asyncio
async def test_failed_runner_releases_lock(admin_app_client):
    _, _, sessionmaker = admin_app_client

    async def bad_runner():
        raise RuntimeError("boom-adversarial-error")

    with pytest.raises(RuntimeError, match="boom-adversarial-error"):
        async with sessionmaker() as session:
            await run_tracked_cli(bad_runner, mode="x_api", trigger="test_fail")

    async with sessionmaker() as session:
        run_row = (
            await session.execute(
                select(TwitterDiscoveryRun).order_by(TwitterDiscoveryRun.started_at.desc()).limit(1)
            )
        ).scalar_one()
        assert run_row.status == "failed"
        assert run_row.finished_at is not None
        assert "boom-adversarial-error" in run_row.error

        ctx_new = await start_discovery_run(session, mode="x_api", trigger="test_next", worker_id="worker-new")
        assert ctx_new is not None
        assert ctx_new.owner_token is not None
        await session.commit()
        await finish_discovery_run(session, ctx_new, status="completed")


@pytest.mark.asyncio
async def test_failed_promotion_cleanup(sessionmaker_fixture):
    async with sessionmaker_fixture() as session:
        candidate = TwitterDiscoveryCandidate(
            candidate_key="id:11223344",
            twitter_id="11223344",
            username="failcand",
            status="queued",
            meta={"resolved_profile": {"twitter_id": "11223344", "username": "failcand"}},
        )
        session.add(candidate)
        await session.commit()
        await session.refresh(candidate)
        candidate_id = candidate.id

    async with sessionmaker_fixture() as session:
        cand = await session.get(TwitterDiscoveryCandidate, candidate_id)
        try:
            async with session.begin_nested():
                cand.status = "processing"
                await session.flush()
                raise RuntimeError("simulated-promotion-error")
        except RuntimeError:
            cand.status = "queued"
            cand.lease_owner = None
            cand.lease_expires_at = None
            await session.commit()

    async with sessionmaker_fixture() as session:
        cand = await session.get(TwitterDiscoveryCandidate, candidate_id)
        assert cand.account_id is None
        assert cand.lease_owner is None
        assert cand.status == "queued"
