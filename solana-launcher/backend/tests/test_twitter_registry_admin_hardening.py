from __future__ import annotations

import asyncio
from datetime import UTC, datetime

import pytest
import pytest_asyncio
from app.core.config import get_settings
from app.db.base import Base
from app.main import create_app
from app.models.twitter_intelligence import (
    TwitterAccount,
    TwitterAccountSnapshot,
    TwitterDiscoveryCandidate,
    TwitterDiscoveryEvidence,
    TwitterPost,
)
from app.schemas.user import UserCreate
from app.services.twitter_discovery_admin_runtime import (
    DiscoveryRunBusy,
    finish_discovery_run,
    start_discovery_run,
)
from app.services.users import create_user
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool


@pytest_asyncio.fixture
async def app_and_client():
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    settings = get_settings()
    app = create_app(settings=settings, engine=engine, sessionmaker=sessionmaker)
    async with sessionmaker() as session:
        await create_user(
            session,
            UserCreate(email="admin-hardening@potapoff.com", password="ChangeMe123!"),
            is_superuser=True,
        )
        await session.commit()

    with TestClient(app) as client:
        login = client.post(
            "/api/v1/auth/login-json",
            json={"email": "admin-hardening@potapoff.com", "password": "ChangeMe123!"},
        )
        assert login.status_code == 200, login.text
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        yield client, headers, sessionmaker

    await engine.dispose()


def test_config_rejects_invalid_and_secret_fields(app_and_client):
    client, headers, _sessionmaker = app_and_client
    response = client.patch(
        "/api/v1/admin/twitter-registry/config",
        json={"process_limit": -1},
        headers=headers,
    )
    assert response.status_code == 422

    response = client.patch(
        "/api/v1/admin/twitter-registry/config",
        json={"X_API_BEARER_TOKEN": "must-never-be-editable"},
        headers=headers,
    )
    assert response.status_code == 422


def test_promote_without_stable_id_is_rejected_without_req_query_param(app_and_client):
    client, headers, sessionmaker = app_and_client

    async def seed() -> int:
        async with sessionmaker() as session:
            candidate = TwitterDiscoveryCandidate(
                candidate_key="username:noidcandidate",
                username="noidcandidate",
                status="queued",
            )
            session.add(candidate)
            await session.commit()
            await session.refresh(candidate)
            return candidate.id

    candidate_id = asyncio.run(seed())
    response = client.post(
        f"/api/v1/admin/twitter-registry/actions/candidates/{candidate_id}/promote",
        headers=headers,
    )
    assert response.status_code == 400
    assert "Stable X user ID unavailable" in response.json()["detail"]
    assert "req" not in response.text


def test_candidate_source_filter_uses_evidence(app_and_client):
    client, headers, sessionmaker = app_and_client

    async def seed() -> None:
        async with sessionmaker() as session:
            dex = TwitterDiscoveryCandidate(
                candidate_key="username:dexsource",
                username="dexsource",
                status="queued",
            )
            seed = TwitterDiscoveryCandidate(
                candidate_key="username:seedsource",
                username="seedsource",
                status="queued",
            )
            session.add_all([dex, seed])
            await session.flush()
            session.add_all(
                [
                    TwitterDiscoveryEvidence(
                        candidate_id=dex.id,
                        source_type="public_web",
                        source_ref="dexscreener:token",
                        discovery_reason="official_social_link:dexscreener",
                    ),
                    TwitterDiscoveryEvidence(
                        candidate_id=seed.id,
                        source_type="curated_seed",
                        source_ref="seeds.json",
                        discovery_reason="seed",
                    ),
                ]
            )
            await session.commit()

    asyncio.run(seed())
    response = client.get(
        "/api/v1/admin/twitter-registry/candidates?source=curated_seed",
        headers=headers,
    )
    assert response.status_code == 200, response.text
    usernames = {item["username"] for item in response.json()["items"]}
    assert "seedsource" in usernames
    assert "dexsource" not in usernames


def test_account_detail_returns_true_counts_over_preview_limit(app_and_client):
    client, headers, sessionmaker = app_and_client

    async def seed() -> int:
        async with sessionmaker() as session:
            account = TwitterAccount(twitter_id="987654321", username="countcheck")
            session.add(account)
            await session.flush()
            now = datetime.now(UTC)
            for idx in range(25):
                session.add(
                    TwitterAccountSnapshot(
                        account_id=account.id,
                        captured_at=now,
                        followers_count=idx,
                    )
                )
                session.add(
                    TwitterPost(
                        twitter_post_id=f"countcheck-{idx}",
                        account_id=account.id,
                        text="test",
                        published_at=now,
                    )
                )
            await session.commit()
            return account.id

    account_id = asyncio.run(seed())
    response = client.get(
        f"/api/v1/admin/twitter-registry/accounts/{account_id}",
        headers=headers,
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["snapshots_count"] == 25
    assert payload["posts_count"] == 25
    assert len(payload["snapshots"]) == 20
    assert len(payload["posts"]) == 20


@pytest.mark.asyncio
async def test_run_lock_is_atomic_and_releases():
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async def claim(worker: str):
        async with sessionmaker() as session:
            return await start_discovery_run(
                session,
                mode="public_no_x_api",
                trigger="test",
                worker_id=worker,
                config_snapshot={},
            )

    first = await claim("worker-1")
    with pytest.raises(DiscoveryRunBusy):
        await claim("worker-2")

    async with sessionmaker() as session:
        await finish_discovery_run(session, first, status="completed", summary={})

    second = await claim("worker-2")
    assert second.worker_id == "worker-2"
    async with sessionmaker() as session:
        await finish_discovery_run(session, second, status="completed", summary={})
    await engine.dispose()


@pytest.mark.asyncio
async def test_stale_run_is_recovered():
    from datetime import timedelta

    from app.models.twitter_discovery_admin import TwitterDiscoveryRun, TwitterDiscoveryRunLock
    from app.services.twitter_discovery_admin_runtime import recover_stale_discovery_runs

    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with sessionmaker() as session:
        run = TwitterDiscoveryRun(status="running", worker_id="dead-worker", mode="public_no_x_api")
        session.add(run)
        await session.flush()
        session.add(
            TwitterDiscoveryRunLock(
                lock_key="twitter-discovery",
                owner_token="stale-owner",
                run_id=run.id,
                lease_expires_at=datetime.now(UTC) - timedelta(seconds=1),
            )
        )
        await session.commit()
        recovered = await recover_stale_discovery_runs(session)
        assert recovered >= 1
        await session.refresh(run)
        assert run.status == "failed"
        assert run.finished_at is not None
    await engine.dispose()
