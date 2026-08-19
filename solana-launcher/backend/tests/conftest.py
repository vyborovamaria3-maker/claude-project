import pytest_asyncio
from app.core.config import Settings
from app.db.base import Base
from app.main import create_app
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

TEST_SECRET_KEY = "a9f4c2e8d7b1f6a3c9e5d2b8f7a4c1e9d6b3f8a2c5e7d4b9a1f3c6e8d2b7a5c9"
TEST_BACKEND_API_KEY = "test-backend-api-key-0123456789abcdef"


@pytest_asyncio.fixture
async def test_app():
    settings = Settings(
        database_url="sqlite+aiosqlite://",
        debug=True,
        secret_key=TEST_SECRET_KEY,
        admin_session_secret="test-admin-session-secret",
        admin_username="admin@example.com",
        admin_password="password123",
        backend_api_key=TEST_BACKEND_API_KEY,
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
