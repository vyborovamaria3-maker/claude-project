from datetime import datetime, timezone

import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.models.twitter_intelligence import (
    TwitterAccount,
    TwitterDiscoveryCandidate,
    TwitterDiscoveryEvidence,
)
from app.services.twitter_discovery import (
    ResolvedTwitterProfile,
    claim_discovery_candidates,
    enqueue_discovery_candidate,
    mark_candidate_failed,
    profile_from_meta,
    profile_to_meta,
    promote_candidate,
)
from app.services.twitter_discovery_sources import extract_x_handles


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


async def test_candidate_deduplicates_across_sources(session: AsyncSession):
    first = await enqueue_discovery_candidate(
        session,
        username="@AlphaCaller",
        priority=60,
        relevance_hint=40,
        source_type="curated_seed",
        source_ref="seed.json",
        discovery_reason="seed",
    )
    second = await enqueue_discovery_candidate(
        session,
        username="alphacaller",
        priority=80,
        relevance_hint=70,
        source_type="public_web",
        source_ref="https://example.com/research",
        discovery_reason="explicit_x_profile_link",
    )
    assert first.id == second.id
    assert second.username == "alphacaller"
    assert second.priority == 80
    assert second.relevance_hint == 70

    candidate_count = await session.scalar(
        select(func.count(TwitterDiscoveryCandidate.id))
    )
    evidence_count = await session.scalar(
        select(func.count(TwitterDiscoveryEvidence.id))
    )
    assert candidate_count == 1
    assert evidence_count == 2


async def test_resolved_id_reuses_username_candidate_and_promotes(session: AsyncSession):
    candidate = await enqueue_discovery_candidate(
        session,
        username="SignalDesk",
        account_type_hint="media",
        source_type="curated_seed",
        source_ref="seed.json",
        discovery_reason="crypto_media",
        relevance_hint=80,
    )
    profile = ResolvedTwitterProfile(
        twitter_id="123456789",
        username="SignalDesk",
        display_name="Signal Desk",
        bio="Solana, crypto and memecoin market news",
        followers_count=120_000,
        source="x_api_profile",
        x_created_at=datetime(2020, 1, 1, tzinfo=timezone.utc),
    )
    accepted, account_id, score = await promote_candidate(
        session,
        candidate,
        profile,
        min_relevance=35,
    )
    assert accepted is True
    assert account_id is not None
    assert score >= 80
    assert candidate.status == "accepted"

    same = await enqueue_discovery_candidate(
        session,
        twitter_id="123456789",
        username="signaldesk",
        source_type="x_following",
        source_ref="42:following",
        discovery_reason="network_following",
    )
    assert same.id == candidate.id
    assert await session.scalar(select(func.count(TwitterAccount.id))) == 1


async def test_resolved_duplicate_merges_evidence_into_canonical_candidate(
    session: AsyncSession,
):
    canonical = await enqueue_discovery_candidate(
        session,
        twitter_id="777777",
        username="canonical_alpha",
        relevance_hint=80,
        source_type="curated_seed",
        source_ref="seed.json",
        discovery_reason="seed",
    )
    duplicate = await enqueue_discovery_candidate(
        session,
        username="old_alpha_handle",
        relevance_hint=70,
        source_type="public_web",
        source_ref="project-site",
        discovery_reason="official_social_link",
    )
    profile = ResolvedTwitterProfile(
        twitter_id="777777",
        username="old_alpha_handle",
        display_name="Alpha Caller",
        bio="Solana memecoin alpha trader",
        followers_count=10_000,
        source="test",
    )

    accepted, account_id, _ = await promote_candidate(
        session,
        duplicate,
        profile,
        min_relevance=0,
    )

    assert accepted is True
    assert account_id is not None
    assert duplicate.status == "duplicate"
    assert duplicate.last_error == f"merged_into_candidate:{canonical.id}"
    evidence_count = await session.scalar(
        select(func.count(TwitterDiscoveryEvidence.id)).where(
            TwitterDiscoveryEvidence.candidate_id == canonical.id
        )
    )
    assert evidence_count == 2
    assert canonical.relevance_hint >= 80


async def test_low_relevance_candidate_stays_out_of_registry(session: AsyncSession):
    candidate = await enqueue_discovery_candidate(
        session,
        username="landscapephotos",
        source_type="x_followers",
        source_ref="123:followers",
        discovery_reason="network_followers",
    )
    profile = ResolvedTwitterProfile(
        twitter_id="998877",
        username="landscapephotos",
        display_name="Landscape Photos",
        bio="Mountains, travel and film photography",
        followers_count=500_000,
        source="x_api_followers",
    )
    accepted, account_id, score = await promote_candidate(
        session,
        candidate,
        profile,
        min_relevance=35,
    )
    assert accepted is False
    assert account_id is None
    assert score < 35
    assert candidate.status == "rejected"
    assert await session.scalar(select(func.count(TwitterAccount.id))) == 0


async def test_claim_and_retry_preserve_frontier(session: AsyncSession):
    await enqueue_discovery_candidate(
        session,
        username="queued_account",
        source_type="curated_seed",
        source_ref="seed.json",
    )
    rows = await claim_discovery_candidates(
        session,
        worker_id="test-worker",
        limit=1,
        lease_seconds=60,
    )
    assert len(rows) == 1
    candidate = rows[0]
    assert candidate.status == "processing"
    assert candidate.attempts == 1
    assert candidate.lease_owner == "test-worker"

    await mark_candidate_failed(
        session,
        candidate,
        error="temporary_failure",
        base_backoff_seconds=30,
    )
    assert candidate.status == "retry"
    assert candidate.next_attempt_at is not None
    assert candidate.lease_owner is None


async def test_resolved_profile_roundtrip():
    profile = ResolvedTwitterProfile(
        twitter_id="123",
        username="solana_signal",
        bio="solana memecoin research",
        x_created_at=datetime(2024, 2, 1, tzinfo=timezone.utc),
    )
    restored = profile_from_meta({"resolved_profile": profile_to_meta(profile)})
    assert restored is not None
    assert restored.twitter_id == "123"
    assert restored.username == "solana_signal"
    assert restored.x_created_at == profile.x_created_at


def test_extract_x_handles_only_uses_explicit_profile_links():
    text = """
    <a href="https://x.com/solana">Solana</a>
    <a href="https://twitter.com/CoinDesk/status/123">story</a>
    <a href="https://x.com/home">not a profile</a>
    <a href="https://x.com/solana?lang=en">duplicate</a>
    """
    assert extract_x_handles(text) == ["solana", "coindesk"]
