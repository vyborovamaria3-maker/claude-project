from datetime import datetime, timezone

import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.models.twitter_intelligence import TwitterAccountTokenStat
from app.services.twitter_account_registry import (
    upsert_twitter_account,
    upsert_twitter_account_score,
)
from app.services.twitter_discovery import (
    ResolvedTwitterProfile,
    enqueue_discovery_candidate,
    promote_candidate,
)
from app.services.twitter_discovery_scoring import rescore_discovery_candidate


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


async def test_source_diversity_increases_discovery_score(session: AsyncSession):
    candidate = await enqueue_discovery_candidate(
        session,
        username="multialpha",
        relevance_hint=60,
        source_type="curated_seed",
        source_ref="seed.json",
        discovery_reason="seed",
    )
    first = await rescore_discovery_candidate(session, candidate)
    first_score = first.discovery_score
    first_source_score = first.source_score

    await enqueue_discovery_candidate(
        session,
        username="multialpha",
        relevance_hint=60,
        source_type="x_search",
        source_ref="solana memecoin",
        discovery_reason="search",
    )
    await enqueue_discovery_candidate(
        session,
        username="multialpha",
        relevance_hint=60,
        source_type="public_web",
        source_ref="https://example.com/research",
        discovery_reason="explicit_x_profile_link",
    )
    second = await rescore_discovery_candidate(session, candidate)

    assert second.source_score > first_source_score
    assert second.discovery_score > first_score
    assert second.source_type_count == 3
    assert second.evidence_count == 3


async def test_trusted_parent_increases_graph_quality(session: AsyncSession):
    parent = await upsert_twitter_account(
        session,
        twitter_id="111",
        username="trusted_parent",
        followers_count=100_000,
        source="test",
        record_snapshot=False,
    )
    await upsert_twitter_account_score(
        session,
        account_id=parent.id,
        influence_score=90,
        trust_score=95,
        alpha_score=88,
        score_confidence=90,
        score_source="test",
    )

    child = await enqueue_discovery_candidate(
        session,
        username="child_alpha",
        relevance_hint=60,
        parent_account_id=parent.id,
        source_type="x_following",
        source_ref="111:following",
        discovery_reason="network_following",
    )
    baseline = await enqueue_discovery_candidate(
        session,
        username="baseline_alpha",
        relevance_hint=60,
        source_type="x_following",
        source_ref="222:following",
        discovery_reason="network_following",
    )

    child_score = await rescore_discovery_candidate(session, child)
    baseline_score = await rescore_discovery_candidate(session, baseline)

    assert child_score.graph_score > 80
    assert baseline_score.graph_score == 0
    assert child_score.discovery_score > baseline_score.discovery_score


async def test_early_call_history_lifts_priority(session: AsyncSession):
    candidate = await enqueue_discovery_candidate(
        session,
        username="early_caller",
        relevance_hint=80,
        source_type="x_search",
        source_ref="solana alpha",
        discovery_reason="search",
    )
    await enqueue_discovery_candidate(
        session,
        username="early_caller",
        relevance_hint=80,
        source_type="curated_seed",
        source_ref="seed.json",
        discovery_reason="seed",
    )
    await enqueue_discovery_candidate(
        session,
        username="early_caller",
        relevance_hint=80,
        source_type="public_web",
        source_ref="https://example.com/early-caller",
        discovery_reason="official_social_link",
    )
    profile = ResolvedTwitterProfile(
        twitter_id="333",
        username="early_caller",
        display_name="Early Caller",
        bio="Solana memecoin trader and onchain alpha",
        followers_count=35_000,
        following_count=900,
        tweet_count=12_000,
        source="test",
        x_created_at=datetime(2021, 1, 1, tzinfo=timezone.utc),
    )
    accepted, account_id, _ = await promote_candidate(
        session,
        candidate,
        profile,
        min_relevance=0,
    )
    assert accepted is True
    assert account_id is not None

    await upsert_twitter_account_score(
        session,
        account_id=account_id,
        influence_score=60,
        trust_score=82,
        alpha_score=90,
        crypto_relevance_score=95,
        solana_relevance_score=96,
        score_confidence=90,
        score_source="test",
    )
    session.add(
        TwitterAccountTokenStat(
            account_id=account_id,
            mint_address="Mint111111111111111111111111111111111111",
            mentions_count=10,
            successful_calls=8,
            failed_calls=2,
            token_alpha_score=85,
        )
    )
    await session.flush()

    score = await rescore_discovery_candidate(session, candidate)

    assert score.early_signal_score >= 85
    assert score.confidence >= 70
    assert candidate.priority == round(score.discovery_score)


async def test_rescore_does_not_rewrite_shared_candidate_metadata(session: AsyncSession):
    candidate = await enqueue_discovery_candidate(
        session,
        username="metasafealpha",
        relevance_hint=72,
        source_type="x_search",
        source_ref="metadata safety",
        discovery_reason="search",
    )
    original_meta = {
        "resolved_profile": {
            "twitter_id": "444",
            "username": "metasafealpha",
            "followers_count": 12345,
            "following_count": 321,
            "tweet_count": 4567,
            "verified": False,
        },
        "resolver_marker": "must-survive-rescore",
    }
    candidate.meta = original_meta.copy()
    await session.flush()

    score = await rescore_discovery_candidate(session, candidate)

    assert candidate.meta == original_meta
    assert score.components is not None
    assert score.components["score_version"] == "discovery-score-v1"
    assert score.components["resolved_profile"] is True
