import os

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

os.environ.setdefault("SECRET_KEY", "pytest-local-9f4d2a8c7b6e5d3c1a0f8e7d6c5b4a32")
os.environ.setdefault("ADMIN_SESSION_SECRET", "pytest-admin-session-7e6d5c4b3a291807f6e5d4c3b2a1908f")

from app.core.config import Settings
from app.db.base import Base
from app.main import create_app


@pytest_asyncio.fixture
async def test_app():
    settings = Settings(
        database_url="sqlite+aiosqlite://",
        debug=True,
        secret_key="pytest-local-9f4d2a8c7b6e5d3c1a0f8e7d6c5b4a32",
        admin_session_secret="pytest-admin-session-7e6d5c4b3a291807f6e5d4c3b2a1908f",
        admin_username="admin@example.com",
        admin_password="password123",
    )
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    app = create_app(settings=settings, engine=engine, sessionmaker=sessionmaker)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield app
    await engine.dispose()


@pytest_asyncio.fixture
async def client(test_app):
    transport = ASGITransport(app=test_app)
    async with AsyncClient(transport=transport, base_url="http://test") as async_client:
        yield async_client
