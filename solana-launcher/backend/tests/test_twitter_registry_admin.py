from __future__ import annotations

import pytest_asyncio
from app.core.config import get_settings
from app.db.base import Base
from app.main import create_app
from app.models.twitter_crawler_settings import TwitterCrawlerSettings
from app.schemas.user import UserCreate
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
        # Create admin user
        await create_user(
            session,
            UserCreate(email="admin@potapoff.com", password="ChangeMe123!"),
            is_superuser=True,
        )
        # Create normal user
        await create_user(
            session,
            UserCreate(email="user@potapoff.com", password="UserPassword123!"),
            is_superuser=False,
        )
        session.add(TwitterCrawlerSettings(id=1))
        await session.commit()

    with TestClient(app) as client:
        yield client, sessionmaker

    await engine.dispose()


def test_admin_endpoints_require_superuser(app_and_client):
    client, sessionmaker = app_and_client
    # Unauthenticated
    resp = client.get("/api/v1/admin/twitter-registry/overview")
    assert resp.status_code == 401

    # Login as normal user
    login_resp = client.post(
        "/api/v1/auth/login-json",
        json={"email": "user@potapoff.com", "password": "UserPassword123!"},
    )
    assert login_resp.status_code == 200
    token = login_resp.json()["access_token"]

    resp = client.get(
        "/api/v1/admin/twitter-registry/overview",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


def test_admin_endpoints_success_for_superuser(app_and_client):
    client, sessionmaker = app_and_client
    login_resp = client.post(
        "/api/v1/auth/login-json",
        json={"email": "admin@potapoff.com", "password": "ChangeMe123!"},
    )
    assert login_resp.status_code == 200, login_resp.text
    token = login_resp.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    # Overview
    resp = client.get("/api/v1/admin/twitter-registry/overview", headers=headers)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "status" in data
    assert "x_api_configured" in data
    assert isinstance(data["x_api_configured"], bool)

    # Candidates list
    resp = client.get("/api/v1/admin/twitter-registry/candidates", headers=headers)
    assert resp.status_code == 200
    assert "items" in resp.json()

    # Config
    resp = client.get("/api/v1/admin/twitter-registry/config", headers=headers)
    assert resp.status_code == 200
    assert "discovery_enabled" in resp.json()

    # Patch config
    patch_resp = client.patch(
        "/api/v1/admin/twitter-registry/config",
        json={"cmc_limit": 75},
        headers=headers,
    )
    assert patch_resp.status_code == 200
    assert patch_resp.json()["config"]["cmc_limit"] == 75
