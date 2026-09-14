from __future__ import annotations

import asyncio
import threading
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
import pytest_asyncio
from app.api.deps import get_current_superuser
from app.api.v1 import twitter_registry_admin_compat as compat
from app.cli import twitter_discovery_cycle as cycle
from app.core.config import get_settings
from app.db.base import Base
from app.db.session import get_db
from app.models.twitter_crawler_run import TwitterCrawlerRun
from app.models.twitter_crawler_settings import TwitterCrawlerSettings
from app.models.twitter_intelligence import TwitterAccount, TwitterDiscoveryCandidate
from app.services import twitter_crawler_runs as runs
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import func, select, update
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest_asyncio.fixture
async def compat_runtime(tmp_path, monkeypatch):
    db_file = tmp_path / "twitter-registry-adversarial.sqlite3"
    db_url = f"sqlite+aiosqlite:///{db_file}"
    settings = get_settings().model_copy(
        update={
            "database_url": db_url,
            "debug": False,
        }
    )
    engine = create_async_engine(
        db_url,
        connect_args={"check_same_thread": False, "timeout": 30},
    )
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with sessionmaker() as session:
        session.add(TwitterCrawlerSettings(id=1, min_relevance=0.0))
        await session.commit()

    # The crawler-run service creates its own short-lived engines. Keep those
    # engines pointed at the same file-backed test database as the HTTP app.
    monkeypatch.setattr(runs, "get_settings", lambda: settings)

    app = FastAPI()
    app.state.settings = settings

    async def override_superuser():
        return SimpleNamespace(
            id=1,
            email="test-superuser@potapoff.local",
            is_superuser=True,
        )

    async def override_db():
        async with sessionmaker() as session:
            yield session

    app.dependency_overrides[get_current_superuser] = override_superuser
    app.dependency_overrides[get_db] = override_db
    app.include_router(compat.router, prefix="/api/v1/admin/twitter-registry")

    with TestClient(app, raise_server_exceptions=False) as client:
        yield client, sessionmaker

    await engine.dispose()


def test_admin_run_http_concurrent_requests_use_atomic_crawler_claim(
    compat_runtime,
    monkeypatch,
):
    client, sessionmaker = compat_runtime
    before_claim = threading.Barrier(2)
    release_winner = threading.Event()

    async def race_runner(_args, _argv):
        # Force both HTTP requests through the route-level precheck before
        # either request attempts the real database singleton claim.
        await asyncio.to_thread(before_claim.wait, 5)
        run_id = await runs.try_start_twitter_crawler_run(
            "twitter_discovery_cycle",
            meta={"trigger": "http_concurrency_regression"},
        )
        if run_id is None:
            return {"skipped": True, "reason": "already_running"}

        released = await asyncio.to_thread(release_winner.wait, 5)
        assert released
        await runs.try_finish_twitter_crawler_run(
            run_id,
            status="success",
            phase="complete",
            summary={"test": True},
        )
        return {"test": True}

    monkeypatch.setattr(compat, "run_cycle_configured", race_runner)

    def request():
        return client.post("/api/v1/admin/twitter-registry/actions/run", json={})

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(request), executor.submit(request)]
        done, _pending = wait(futures, timeout=5, return_when=FIRST_COMPLETED)
        assert done, "one request should lose the atomic claim and return promptly"
        first_response = next(iter(done)).result(timeout=1)
        assert first_response.status_code == 409, first_response.text

        release_winner.set()
        responses = [future.result(timeout=5) for future in futures]

    assert sorted(response.status_code for response in responses) == [200, 409]
    conflict = next(response for response in responses if response.status_code == 409)
    assert "already in progress" in conflict.json()["detail"]

    async def assert_released():
        async with sessionmaker() as session:
            running = int(
                (
                    await session.execute(
                        select(func.count(TwitterCrawlerRun.id)).where(
                            TwitterCrawlerRun.job_name == "twitter_discovery_cycle",
                            TwitterCrawlerRun.status == "running",
                        )
                    )
                ).scalar_one()
                or 0
            )
            assert running == 0

    asyncio.run(assert_released())


@pytest.mark.asyncio
async def test_stale_old_worker_cannot_finish_replacement_run(compat_runtime):
    _client, sessionmaker = compat_runtime

    old_run_id = await runs.start_twitter_crawler_run(
        "twitter_discovery_cycle",
        meta={"worker": "old"},
    )

    async with sessionmaker() as session:
        await session.execute(
            update(TwitterCrawlerRun)
            .where(TwitterCrawlerRun.id == old_run_id)
            .values(heartbeat_at=datetime.now(UTC) - timedelta(hours=3))
        )
        await session.commit()

    new_run_id = await runs.start_twitter_crawler_run(
        "twitter_discovery_cycle",
        meta={"worker": "replacement"},
    )
    assert new_run_id != old_run_id

    # A late completion from the stale worker can only address its own run id.
    await runs.finish_twitter_crawler_run(
        old_run_id,
        status="success",
        phase="complete",
        summary={"late": True},
    )

    async with sessionmaker() as session:
        old_row = await session.get(TwitterCrawlerRun, old_run_id)
        new_row = await session.get(TwitterCrawlerRun, new_run_id)
        assert old_row is not None
        assert old_row.status == "failed"
        assert old_row.phase == "stale"
        assert new_row is not None
        assert new_row.status == "running"

    await runs.finish_twitter_crawler_run(
        new_run_id,
        status="success",
        phase="complete",
        summary={"replacement": True},
    )


@pytest.mark.asyncio
async def test_cycle_exception_marks_failed_and_allows_next_claim(
    compat_runtime,
    monkeypatch,
):
    _client, sessionmaker = compat_runtime
    args = cycle.build_parser().parse_args([])

    async def explode(_args, *, run_id=None):
        assert run_id is not None
        raise RuntimeError("boom-adversarial-cycle")

    monkeypatch.setattr(cycle, "run", explode)

    with pytest.raises(RuntimeError, match="boom-adversarial-cycle"):
        await cycle.run_tracked(args)

    async with sessionmaker() as session:
        failed = (
            await session.execute(
                select(TwitterCrawlerRun)
                .where(TwitterCrawlerRun.job_name == "twitter_discovery_cycle")
                .order_by(TwitterCrawlerRun.id.desc())
                .limit(1)
            )
        ).scalar_one()
        assert failed.status == "failed"
        assert failed.finished_at is not None
        assert "boom-adversarial-cycle" in str(failed.error)

    next_run_id = await runs.try_start_twitter_crawler_run(
        "twitter_discovery_cycle",
        meta={"trigger": "after_failure"},
    )
    assert next_run_id is not None
    await runs.finish_twitter_crawler_run(
        next_run_id,
        status="success",
        phase="complete",
        summary={"after_failure": True},
    )


class _CandidateResult:
    def scalar_one_or_none(self):
        return SimpleNamespace(account_id=123)


class _CapturePromotionSession:
    def __init__(self):
        self.statement = None

    async def execute(self, statement):
        self.statement = statement
        return _CandidateResult()


@pytest.mark.asyncio
async def test_manual_promotion_has_postgres_row_lock_and_unique_account_fence():
    session = _CapturePromotionSession()

    with pytest.raises(HTTPException) as exc:
        await compat.promote_now(candidate_id=7, session=session)

    assert exc.value.status_code == 400
    compiled = str(session.statement.compile(dialect=postgresql.dialect()))
    assert "FOR UPDATE" in compiled.upper()
    assert "uq_twitter_accounts_twitter_id" in {
        constraint.name for constraint in TwitterAccount.__table__.constraints
    }


def test_failed_manual_promotion_rolls_back_partial_candidate_state(
    compat_runtime,
    monkeypatch,
):
    client, sessionmaker = compat_runtime
    twitter_id = "8811223344"

    async def seed_candidate():
        async with sessionmaker() as session:
            candidate = TwitterDiscoveryCandidate(
                candidate_key=f"id:{twitter_id}",
                twitter_id=twitter_id,
                username="failpromote",
                status="queued",
                meta={
                    "resolved_profile": {
                        "twitter_id": twitter_id,
                        "username": "failpromote",
                        "bio": "Solana",
                    }
                },
            )
            session.add(candidate)
            await session.commit()
            await session.refresh(candidate)
            return candidate.id

    candidate_id = asyncio.run(seed_candidate())

    async def explode_after_partial_mutation(
        session,
        candidate,
        _profile,
        *,
        min_relevance,
    ):
        assert min_relevance == 0.0
        candidate.status = "processing"
        candidate.lease_owner = "failed-manual-promotion"
        candidate.lease_expires_at = datetime.now(UTC) + timedelta(minutes=5)
        await session.flush()
        raise RuntimeError("boom-promotion")

    monkeypatch.setattr(compat, "promote_candidate", explode_after_partial_mutation)

    response = client.post(
        f"/api/v1/admin/twitter-registry/actions/candidates/{candidate_id}/promote"
    )
    assert response.status_code == 500

    async def assert_rolled_back():
        async with sessionmaker() as session:
            candidate = await session.get(TwitterDiscoveryCandidate, candidate_id)
            assert candidate is not None
            assert candidate.status == "queued"
            assert candidate.account_id is None
            assert candidate.lease_owner is None
            assert candidate.lease_expires_at is None
            account_count = int(
                (
                    await session.execute(
                        select(func.count(TwitterAccount.id)).where(
                            TwitterAccount.twitter_id == twitter_id
                        )
                    )
                ).scalar_one()
                or 0
            )
            assert account_count == 0

    asyncio.run(assert_rolled_back())
