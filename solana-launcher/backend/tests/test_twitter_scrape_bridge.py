import argparse
from types import SimpleNamespace

import pytest_asyncio

from app.cli import twitter_scrape_bridge as bridge
from app.db.base import Base
from app.models.twitter_discovery_scoring import TwitterDiscoveryScore
from app.models.twitter_intelligence import TwitterDiscoveryCandidate, TwitterDiscoveryEvidence
from app.services.twitter_scrape_bridge import ingest_dev_twitter_stats
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool


@pytest_asyncio.fixture
async def session():
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as value:
        yield value
    await engine.dispose()


def sample_payload():
    return {
        "symbol": "MEME",
        "collectionStrategy": "playwright",
        "topTweets": [
            {
                "id": "1900000000000000001",
                "text": "$MEME looks early, watching the Solana liquidity build",
                "author": "AlphaCaller",
                "likes": 42,
                "retweets": 11,
                "views": 9200,
                "timestamp": 1_780_000_000_000,
                "isSuspicious": False,
            },
            {
                "id": "1900000000000000002",
                "text": "Second $MEME update, volume is accelerating",
                "author": "@AlphaCaller",
                "likes": 65,
                "retweets": 18,
                "views": 15000,
                "timestamp": 1_780_000_060_000,
                "isSuspicious": False,
            },
        ],
        "shillers": [
            {
                "handle": "alphacaller",
                "tweets": 2,
                "totalEngagement": 136,
                "isBot": False,
                "followers": 24000,
                "postsCount": 8000,
                "isVerified": True,
            }
        ],
    }


async def test_bridge_reuses_candidate_and_deduplicates_tweet_evidence(session: AsyncSession):
    mint = "11111111111111111111111111111111"
    first = await ingest_dev_twitter_stats(
        session,
        sample_payload(),
        mint=mint,
        symbol="MEME",
    )
    await session.commit()

    assert first["tweets_seen"] == 2
    assert first["candidates_touched"] == 1
    assert await session.scalar(select(func.count(TwitterDiscoveryCandidate.id))) == 1
    assert await session.scalar(select(func.count(TwitterDiscoveryEvidence.id))) == 2
    assert await session.scalar(select(func.count(TwitterDiscoveryScore.candidate_id))) == 1

    candidate = (await session.execute(select(TwitterDiscoveryCandidate))).scalar_one()
    assert candidate.username == "alphacaller"
    assert candidate.twitter_id is None
    assert candidate.priority >= 60
    assert candidate.meta["last_tweet_collector"] == "playwright"

    await ingest_dev_twitter_stats(
        session,
        sample_payload(),
        mint=mint,
        symbol="MEME",
    )
    await session.commit()

    assert await session.scalar(select(func.count(TwitterDiscoveryCandidate.id))) == 1
    assert await session.scalar(select(func.count(TwitterDiscoveryEvidence.id))) == 2


async def test_bridge_skips_malformed_rows_and_keeps_valid_tweets(session: AsyncSession):
    payload = sample_payload()
    payload["topTweets"] = [
        {"id": "bad-id", "text": "bad", "author": "broken/handle"},
        None,
        payload["topTweets"][0],
    ]
    payload["shillers"] = [
        {"handle": "broken/handle", "tweets": "not-a-number"},
        payload["shillers"][0],
    ]

    result = await ingest_dev_twitter_stats(
        session,
        payload,
        mint="11111111111111111111111111111111",
        symbol="MEME",
    )
    await session.commit()

    assert result["tweets_seen"] == 3
    assert result["skipped"] == 2
    assert result["evidence_processed"] == 1
    assert result["candidates_touched"] == 1
    assert await session.scalar(select(func.count(TwitterDiscoveryCandidate.id))) == 1
    assert await session.scalar(select(func.count(TwitterDiscoveryEvidence.id))) == 1



async def test_internal_collector_request_does_not_use_environment_proxy(monkeypatch):
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"collectionStrategy": "auto", "topTweets": [], "shillers": []}

    class FakeClient:
        def __init__(self, **kwargs):
            captured["client_kwargs"] = kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, url, headers):
            captured["url"] = url
            captured["headers"] = headers
            return FakeResponse()

    class FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def commit(self):
            return None

    class FakeEngine:
        async def dispose(self):
            return None

    async def heartbeat(*args, **kwargs):
        return None

    async def ingest(*args, **kwargs):
        return {"accepted": True}

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("INTERNAL_SERVICE_API_KEY", "a" * 64)
    monkeypatch.setattr(
        bridge,
        "get_settings",
        lambda: SimpleNamespace(
            environment="production",
            frontend_internal_url="http://frontend:3000",
        ),
    )
    monkeypatch.setattr(bridge.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(bridge, "try_heartbeat_twitter_crawler_run", heartbeat)
    monkeypatch.setattr(
        bridge,
        "create_engine_and_sessionmaker",
        lambda settings: (FakeEngine(), FakeSession),
    )
    monkeypatch.setattr(bridge, "ingest_dev_twitter_stats", ingest)

    result = await bridge.run(
        argparse.Namespace(
            mint="11111111111111111111111111111111",
            symbol="MEME",
            twitter="",
            scope="mentions",
            strategy="auto",
            limit=10,
            hours="24",
            frontend_base="",
            timeout=10,
        )
    )

    assert result["registry"] == {"accepted": True}
    assert captured["client_kwargs"]["trust_env"] is False
    assert captured["url"].startswith("http://frontend:3000/")
    assert captured["headers"] == {"x-internal-service-key": "a" * 64}
