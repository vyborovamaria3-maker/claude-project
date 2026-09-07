import asyncio
from types import SimpleNamespace

from sqlalchemy import func, select
from sqlalchemy.dialects import postgresql

from app.core.config import Settings
from app.models.analytics import Token, TokenLatestMetric, TokenMetric
from app.services import market_ingestion
from app.services.etl import TokenSourcePayload


class FakeResponse:
    def __init__(self, payload, *, status_code=200, headers=None):
        self.payload = payload
        self.status_code = status_code
        self.headers = headers or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self.payload


async def test_birdeye_requests_share_one_bounded_semaphore(monkeypatch):
    active = 0
    max_active = 0
    calls = 0

    class FakeClient:
        async def get(self, url, headers=None):
            nonlocal active, max_active, calls
            del headers
            calls += 1
            active += 1
            max_active = max(max_active, active)
            try:
                await asyncio.sleep(0.01)
                if "/defi/price" in url:
                    return FakeResponse(
                        {"data": {"value": 1.5, "marketCap": 123_000}}
                    )
                if "/token/holder" in url:
                    return FakeResponse({"data": {"holderCount": 42}})
                return FakeResponse(
                    {"data": {"volume24h": 10_000, "liquidity": 8_000}}
                )
            finally:
                active -= 1

    async def no_cache(_key):
        return None

    async def no_write(_key, _value, ttl_seconds):
        del ttl_seconds

    monkeypatch.setattr(market_ingestion, "_safe_cache_read", no_cache)
    monkeypatch.setattr(market_ingestion, "_safe_cache_write", no_write)

    settings = Settings(secret_key="a" * 64, environment="test")
    semaphore = asyncio.Semaphore(2)
    client = FakeClient()
    results = await asyncio.gather(
        *(
            market_ingestion.fetch_birdeye_metrics(
                client,
                f"mint-{index}",
                settings,
                semaphore,
            )
            for index in range(4)
        )
    )

    assert len(results) == 4
    assert calls == 12
    assert max_active == 2


async def test_birdeye_retry_uses_retry_after_then_exponential_backoff(monkeypatch):
    responses = [
        FakeResponse({}, status_code=429, headers={"Retry-After": "1.25"}),
        FakeResponse({}, status_code=503),
        FakeResponse({"ok": True}),
    ]
    sleeps: list[float] = []

    class FakeClient:
        async def get(self, _url, headers=None):
            del headers
            return responses.pop(0)

    async def fake_sleep(delay):
        sleeps.append(delay)

    monkeypatch.setattr(market_ingestion.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(market_ingestion.random, "uniform", lambda _a, _b: 0.0)

    settings = Settings(
        secret_key="r" * 64,
        environment="test",
        birdeye_max_retries=2,
        birdeye_backoff_base_seconds=0.5,
        birdeye_backoff_max_seconds=8.0,
    )
    payload = await market_ingestion._request_json(
        FakeClient(),
        "https://birdeye.invalid/test",
        retry_settings=settings,
    )

    assert payload == {"ok": True}
    assert sleeps == [1.25, 1.0]
    assert responses == []


async def test_market_ingestion_limits_can_be_configured_through_settings():
    settings = Settings(
        secret_key="e" * 64,
        environment="test",
        BIRDEYE_REQUEST_CONCURRENCY=7,
        BIRDEYE_TOKEN_BATCH_SIZE=55,
        BIRDEYE_TIMEOUT_SECONDS=11,
        BIRDEYE_MAX_RETRIES=4,
        BIRDEYE_BACKOFF_BASE_SECONDS=0.25,
        BIRDEYE_BACKOFF_MAX_SECONDS=5,
    )

    assert settings.birdeye_request_concurrency == 7
    assert settings.birdeye_token_batch_size == 55
    assert settings.birdeye_timeout_seconds == 11
    assert settings.birdeye_max_retries == 4
    assert settings.birdeye_backoff_base_seconds == 0.25
    assert settings.birdeye_backoff_max_seconds == 5


async def test_metric_sync_fetches_concurrently_but_flushes_hot_state_safely(
    test_app,
    monkeypatch,
):
    async with test_app.state.sessionmaker() as session:
        session.add_all(
            [Token(mint_address=f"metric-mint-{index}") for index in range(6)]
        )
        await session.commit()

    active = 0
    max_active = 0

    async def fake_metrics(_client, mint_address, _settings, semaphore):
        nonlocal active, max_active
        async with semaphore:
            active += 1
            max_active = max(max_active, active)
            try:
                await asyncio.sleep(0.01)
            finally:
                active -= 1
        index = int(mint_address.rsplit("-", 1)[-1])
        return {
            "price": {
                "data": {
                    "value": index + 1,
                    "marketCap": 100_000 + index,
                }
            },
            "ohlcv": {
                "data": {
                    "volume24h": 1_000 + index,
                    "liquidity": 500 + index,
                }
            },
            "holders": {"data": {"holderCount": 10 + index}},
        }

    async def fake_social(_mint_address, _settings):
        return {
            "twitter_url": None,
            "telegram_url": None,
            "discord_url": None,
            "website_url": None,
        }

    monkeypatch.setattr(market_ingestion, "fetch_birdeye_metrics", fake_metrics)
    monkeypatch.setattr(market_ingestion, "_safe_social_links", fake_social)

    settings = Settings(secret_key="b" * 64, environment="test")
    async with test_app.state.sessionmaker() as session:
        count = await market_ingestion.sync_metrics_for_active_tokens(
            session,
            settings,
            request_concurrency=2,
            token_batch_size=6,
        )
        await session.commit()

        metric_count = int(
            await session.scalar(select(func.count()).select_from(TokenMetric)) or 0
        )
        hot_count = int(
            await session.scalar(select(func.count()).select_from(TokenLatestMetric)) or 0
        )
        hottest = (
            await session.execute(
                select(TokenLatestMetric)
                .order_by(TokenLatestMetric.price_usd.desc())
                .limit(1)
            )
        ).scalar_one()

    assert count == 6
    assert metric_count == 6
    assert hot_count == 6
    assert max_active == 2
    assert hottest.price_usd == 6.0
    assert hottest.market_cap == 100_005.0
    assert hottest.volume_24h == 1_005.0
    assert hottest.holder_count == 15


async def test_pumpfun_cache_serializes_slotted_payloads_with_asdict(monkeypatch):
    cached_value = None

    class FakeClient:
        async def get(self, _url, headers=None):
            del headers
            return FakeResponse(
                [
                    {
                        "mint": "pump-mint",
                        "name": "Pump",
                        "symbol": "PMP",
                        "createdAt": "2026-09-06T12:00:00Z",
                    }
                ]
            )

    async def no_cache(_key):
        return None

    async def capture_write(_key, value, ttl_seconds):
        nonlocal cached_value
        del ttl_seconds
        cached_value = value

    monkeypatch.setattr(market_ingestion, "_safe_cache_read", no_cache)
    monkeypatch.setattr(market_ingestion, "_safe_cache_write", capture_write)

    settings = Settings(secret_key="c" * 64, environment="test")
    tokens = await market_ingestion.fetch_pumpfun_tokens(FakeClient(), settings)

    assert len(tokens) == 1
    assert tokens[0].mint_address == "pump-mint"
    assert cached_value[0]["mint_address"] == "pump-mint"
    assert cached_value[0]["symbol"] == "PMP"


async def test_postgres_pumpfun_refresh_compiles_to_one_on_conflict_upsert():
    class FakeSession:
        def __init__(self):
            self.statement = None

        def get_bind(self):
            return SimpleNamespace(dialect=postgresql.dialect())

        async def execute(self, statement):
            self.statement = statement

    session = FakeSession()
    payloads = [
        TokenSourcePayload(
            mint_address="bulk-pump-a",
            name="Alpha",
            symbol="AAA",
        ),
        TokenSourcePayload(
            mint_address="bulk-pump-b",
            name="Beta",
            symbol="BBB",
        ),
        # The provider can theoretically return duplicate rows; dedupe before the
        # PostgreSQL upsert because ON CONFLICT cannot update the same row twice.
        TokenSourcePayload(
            mint_address="bulk-pump-a",
            name="Alpha New",
            symbol="AAA",
            migrated_to_raydium=True,
            status="migrated",
        ),
    ]

    count = await market_ingestion._bulk_upsert_pumpfun_tokens(session, payloads)
    compiled = str(
        session.statement.compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": False},
        )
    )

    assert count == 2
    assert compiled.count("INSERT INTO tokens") == 1
    assert "ON CONFLICT (mint_address) DO UPDATE" in compiled
    assert "last_synced_at" in compiled


async def test_sqlite_pumpfun_fallback_keeps_existing_metadata(test_app):
    async with test_app.state.sessionmaker() as session:
        first = TokenSourcePayload(
            mint_address="fallback-pump",
            name="Original",
            symbol="ORG",
            creator_wallet="creator-a",
        )
        second = TokenSourcePayload(
            mint_address="fallback-pump",
            name=None,
            symbol=None,
            creator_wallet=None,
            migrated_to_raydium=True,
            status="migrated",
        )
        assert await market_ingestion._bulk_upsert_pumpfun_tokens(session, [first]) == 1
        assert await market_ingestion._bulk_upsert_pumpfun_tokens(session, [second]) == 1
        await session.commit()

        token = (
            await session.execute(
                select(Token).where(Token.mint_address == "fallback-pump")
            )
        ).scalar_one()

    assert token.name == "Original"
    assert token.symbol == "ORG"
    assert token.creator_wallet == "creator-a"
    assert token.migrated_to_raydium is True
    assert token.status == "migrated"
