from decimal import Decimal

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.core.config import Settings
from app.db.base import Base
from app.main import create_app
from app.models.subscription_settings import SubscriptionSettings


TEST_SECRET_KEY = "a9f4c2e8d7b1f6a3c9e5d2b8f7a4c1e9d6b3f8a2c5e7d4b9a1f3c6e8d2b7a5c9"
TEST_SUBSCRIPTION_RECIPIENT = "11111111111111111111111111111111"


@pytest_asyncio.fixture
async def test_app():
    settings = Settings(
        database_url="sqlite+aiosqlite://",
        debug=True,
        secret_key=TEST_SECRET_KEY,
        admin_session_secret="test-admin-session-secret",
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


@pytest_asyncio.fixture
async def configured_subscription_settings(test_app):
    """Enable deterministic SOL/USDT/demo policy for subscription regression tests."""
    async with test_app.state.sessionmaker() as session:
        settings = await session.get(SubscriptionSettings, 1)
        if settings is None:
            settings = SubscriptionSettings(id=1)
            session.add(settings)
        settings.monthly_price_sol = Decimal("0.25")
        settings.monthly_price_usdt = Decimal("50")
        settings.paid_subscriptions_enabled = True
        settings.free_demo_enabled = True
        settings.demo_days = 14
        settings.solana_recipient_wallet = TEST_SUBSCRIPTION_RECIPIENT
        await session.commit()
    yield
