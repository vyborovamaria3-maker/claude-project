import asyncio

from sqlalchemy import func, select

from app.core.config import Settings
from app.models.analytics import Token, TokenLatestMetric, TokenMetric
from app.services import market_ingestion


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

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
