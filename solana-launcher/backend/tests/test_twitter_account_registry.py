from datetime import UTC, datetime

import pytest
import pytest_asyncio
from app.db.base import Base
from app.models.twitter_intelligence import TwitterAccount, TwitterAccountSnapshot, TwitterPostToken
from app.services.twitter_account_registry import (
    link_twitter_post_token,
    normalize_twitter_username,
    upsert_twitter_account,
    upsert_twitter_account_score,
    upsert_twitter_post,
)
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool


@pytest_asyncio.fixture
async def db_session():
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with sessionmaker() as session:
        yield session
    await engine.dispose()


async def test_account_upsert_uses_stable_twitter_id_and_records_history(
    db_session: AsyncSession,
):
    observed = datetime(2026, 9, 12, 12, 0, tzinfo=UTC)
    account = await upsert_twitter_account(
        db_session,
        twitter_id="123456789",
        username="@AlphaOne",
        display_name="Alpha One",
        followers_count=100,
        following_count=12,
        tweet_count=25,
        verified=False,
        observed_at=observed,
        source="twitter_api",
    )
    same_account = await upsert_twitter_account(
        db_session,
        twitter_id=123456789,
        username="ALPHA_TWO",
        followers_count=150,
        observed_at=observed,
        source="twitter_api",
    )

    account_count = await db_session.scalar(select(func.count()).select_from(TwitterAccount))
    snapshot_count = await db_session.scalar(
        select(func.count()).select_from(TwitterAccountSnapshot)
    )

    assert same_account.id == account.id
    assert same_account.username == "alpha_two"
    assert same_account.followers_count == 150
    assert account_count == 1
    assert snapshot_count == 2


async def test_post_token_and_score_upserts_are_idempotent(db_session: AsyncSession):
    published_at = datetime(2026, 9, 12, 12, 30, tzinfo=UTC)
    account = await upsert_twitter_account(
        db_session,
        twitter_id="987654321",
        username="signal_account",
        source="collector",
        record_snapshot=False,
    )
    post = await upsert_twitter_post(
        db_session,
        account_id=account.id,
        twitter_post_id="2000000000000000001",
        published_at=published_at,
        text="Watching $TEST",
        likes=10,
        reposts=2,
        spam_probability=0.25,
        source="collector",
    )
    same_post = await upsert_twitter_post(
        db_session,
        account_id=account.id,
        twitter_post_id="2000000000000000001",
        published_at=published_at,
        likes=25,
        views=500,
        spam_probability=2.0,
        source="collector",
    )
    link = await link_twitter_post_token(
        db_session,
        post=same_post,
        mint_address="TestMint111111111111111111111111111111111",
        symbol="test",
        confidence=0.8,
    )
    same_link = await link_twitter_post_token(
        db_session,
        post=same_post,
        mint_address="TestMint111111111111111111111111111111111",
        symbol="TEST",
        confidence=0.95,
    )
    score = await upsert_twitter_account_score(
        db_session,
        account_id=account.id,
        alpha_score=91.5,
        trust_score=82.0,
        shill_score=14.0,
        score_confidence=76.0,
        score_source="reputation_engine",
        model_version="twitter-reputation-v1",
    )

    token_link_count = await db_session.scalar(
        select(func.count()).select_from(TwitterPostToken)
    )

    assert same_post.id == post.id
    assert same_post.likes == 25
    assert same_post.views == 500
    assert same_post.spam_probability == 1.0
    assert same_link.id == link.id
    assert same_link.confidence == 0.95
    assert token_link_count == 1
    assert score.alpha_score == 91.5
    assert score.model_version == "twitter-reputation-v1"


def test_username_normalization_rejects_malformed_handles():
    assert normalize_twitter_username("@Valid_Name") == "valid_name"
    with pytest.raises(ValueError, match="invalid X username"):
        normalize_twitter_username("https://x.com/not-a-handle")
