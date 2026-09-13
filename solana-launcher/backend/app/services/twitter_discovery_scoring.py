from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.twitter_discovery_scoring import TwitterDiscoveryScore
from app.models.twitter_intelligence import (
    TwitterAccount,
    TwitterAccountScore,
    TwitterAccountTokenStat,
    TwitterDiscoveryCandidate,
    TwitterDiscoveryEvidence,
    TwitterPost,
)

DISCOVERY_SCORE_VERSION = "discovery-score-v1"

SOURCE_WEIGHTS: dict[str, float] = {
    "curated_seed": 100.0,
    "x_search": 82.0,
    "x_following": 76.0,
    "public_web": 66.0,
    "x_followers": 44.0,
    "manual": 90.0,
    "unknown": 25.0,
}


@dataclass(slots=True)
class DiscoveryScoreBreakdown:
    discovery_score: float
    confidence: float
    relevance_score: float
    source_score: float
    graph_score: float
    engagement_score: float
    early_signal_score: float
    recency_score: float
    evidence_count: int
    source_type_count: int
    resolved_profile: bool
    token_history_count: int
    score_version: str = DISCOVERY_SCORE_VERSION


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, float(value)))


def _aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _meta_float(meta: dict[str, Any] | None, key: str) -> float:
    if not isinstance(meta, dict):
        return 0.0
    value = meta.get(key)
    try:
        return _clamp(float(value)) if value is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _resolved_profile(meta: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(meta, dict):
        return None
    profile = meta.get("resolved_profile")
    if isinstance(profile, dict) and profile.get("twitter_id"):
        return profile
    return None


def _profile_quality(
    *,
    followers_count: int,
    following_count: int,
    tweet_count: int,
    verified: bool,
) -> float:
    followers = max(0, int(followers_count))
    following = max(0, int(following_count))
    tweets = max(0, int(tweet_count))

    follower_component = min(100.0, math.log10(followers + 1) / 6.0 * 100.0)
    ratio = followers / max(1, following)
    ratio_component = min(100.0, math.log10(ratio + 1.0) / 3.0 * 100.0)
    activity_component = min(100.0, math.log10(tweets + 1) / 5.0 * 100.0)
    verification_component = 100.0 if verified else 0.0
    return _clamp(
        follower_component * 0.55
        + ratio_component * 0.25
        + activity_component * 0.15
        + verification_component * 0.05
    )


async def _evidence_score(
    session: AsyncSession,
    candidate_id: int,
) -> tuple[float, int, int, list[str]]:
    evidence = list(
        (
            await session.execute(
                select(TwitterDiscoveryEvidence.source_type).where(
                    TwitterDiscoveryEvidence.candidate_id == candidate_id
                )
            )
        ).scalars().all()
    )
    source_types = sorted({str(value or "unknown") for value in evidence})
    evidence_count = len(evidence)
    source_type_count = len(source_types)
    best_source = max(
        (SOURCE_WEIGHTS.get(source, SOURCE_WEIGHTS["unknown"]) for source in source_types),
        default=0.0,
    )
    diversity = min(100.0, source_type_count / 4.0 * 100.0)
    repetition = min(100.0, evidence_count / 6.0 * 100.0)
    score = best_source * 0.55 + diversity * 0.30 + repetition * 0.15
    return _clamp(score), evidence_count, source_type_count, source_types


async def _profile_metrics(
    session: AsyncSession,
    candidate: TwitterDiscoveryCandidate,
) -> tuple[dict[str, Any] | None, bool]:
    profile = _resolved_profile(candidate.meta)
    if profile is not None:
        return profile, True
    if candidate.account_id is None:
        return None, False
    account = await session.get(TwitterAccount, candidate.account_id)
    if account is None:
        return None, False
    return {
        "followers_count": account.followers_count,
        "following_count": account.following_count,
        "tweet_count": account.tweet_count,
        "verified": account.verified,
    }, True


async def _engagement_score(
    session: AsyncSession,
    candidate: TwitterDiscoveryCandidate,
    profile: dict[str, Any] | None,
) -> float:
    if profile is None:
        return 0.0
    followers = max(0, int(profile.get("followers_count") or 0))
    profile_score = _profile_quality(
        followers_count=followers,
        following_count=int(profile.get("following_count") or 0),
        tweet_count=int(profile.get("tweet_count") or 0),
        verified=bool(profile.get("verified")),
    )
    if candidate.account_id is None:
        return round(profile_score, 2)

    row = (
        await session.execute(
            select(
                func.count(TwitterPost.id),
                func.avg(
                    TwitterPost.likes
                    + TwitterPost.replies
                    + TwitterPost.reposts
                    + TwitterPost.quotes
                ),
                func.avg(TwitterPost.views),
            ).where(TwitterPost.account_id == candidate.account_id)
        )
    ).one()
    post_count = int(row[0] or 0)
    if post_count == 0:
        return round(profile_score, 2)

    avg_interactions = float(row[1] or 0.0)
    avg_views = float(row[2] or 0.0)
    denominator = max(1, followers)
    interaction_rate = avg_interactions / denominator
    view_rate = avg_views / denominator
    interaction_component = min(100.0, interaction_rate * 5000.0)
    view_component = min(100.0, view_rate * 100.0)
    observed_quality = interaction_component * 0.70 + view_component * 0.30
    return round(_clamp(observed_quality * 0.70 + profile_score * 0.30), 2)


def _network_account_score(score: TwitterAccountScore | None) -> float:
    if score is None:
        return 0.0
    return _clamp(
        score.trust_score * 0.40
        + score.alpha_score * 0.35
        + score.influence_score * 0.25
    )


async def _graph_score(
    session: AsyncSession,
    candidate: TwitterDiscoveryCandidate,
    own_score: TwitterAccountScore | None,
) -> tuple[float, bool]:
    values: list[float] = []
    has_graph_evidence = False
    if candidate.parent_account_id is not None:
        parent_score = await session.get(TwitterAccountScore, candidate.parent_account_id)
        if parent_score is not None:
            values.append(_network_account_score(parent_score))
            has_graph_evidence = True
    if own_score is not None:
        values.append(
            _clamp(own_score.trust_score * 0.55 + own_score.influence_score * 0.45)
        )
        has_graph_evidence = True
    return (round(max(values, default=0.0), 2), has_graph_evidence)


async def _early_signal_score(
    session: AsyncSession,
    candidate: TwitterDiscoveryCandidate,
    own_score: TwitterAccountScore | None,
) -> tuple[float, int]:
    alpha_score = float(own_score.alpha_score) if own_score is not None else 0.0
    if candidate.account_id is None:
        return round(_clamp(alpha_score), 2), 0

    row = (
        await session.execute(
            select(
                func.count(TwitterAccountTokenStat.id),
                func.avg(TwitterAccountTokenStat.token_alpha_score),
                func.sum(TwitterAccountTokenStat.successful_calls),
                func.sum(TwitterAccountTokenStat.failed_calls),
            ).where(TwitterAccountTokenStat.account_id == candidate.account_id)
        )
    ).one()
    history_count = int(row[0] or 0)
    if history_count == 0:
        return round(_clamp(alpha_score), 2), 0

    token_alpha = _clamp(float(row[1] or 0.0))
    successful = int(row[2] or 0)
    failed = int(row[3] or 0)
    evaluated = successful + failed
    success_rate = successful / evaluated * 100.0 if evaluated else 0.0
    if own_score is not None:
        value = alpha_score * 0.55 + token_alpha * 0.30 + success_rate * 0.15
    else:
        value = token_alpha * 0.70 + success_rate * 0.30
    return round(_clamp(value), 2), history_count


def _recency_score(candidate: TwitterDiscoveryCandidate, now: datetime) -> float:
    seen = _aware(candidate.last_seen_at)
    age_days = max(0.0, (now - seen).total_seconds() / 86400.0)
    return round(_clamp(100.0 * math.exp(-age_days / 30.0)), 2)


async def calculate_discovery_score(
    session: AsyncSession,
    candidate: TwitterDiscoveryCandidate,
    *,
    now: datetime | None = None,
) -> DiscoveryScoreBreakdown:
    current_time = _aware(now or datetime.now(timezone.utc))
    source_score, evidence_count, source_type_count, _source_types = await _evidence_score(
        session,
        candidate.id,
    )
    profile, resolved = await _profile_metrics(session, candidate)
    own_score = (
        await session.get(TwitterAccountScore, candidate.account_id)
        if candidate.account_id is not None
        else None
    )

    relevance_values = [
        float(candidate.relevance_hint or 0.0),
        _meta_float(candidate.meta, "relevance_score"),
        _meta_float(candidate.meta, "solana_relevance_score"),
    ]
    if own_score is not None:
        relevance_values.append(
            own_score.crypto_relevance_score * 0.55
            + own_score.solana_relevance_score * 0.45
        )
    relevance_score = round(_clamp(max(relevance_values, default=0.0)), 2)
    engagement_score = await _engagement_score(session, candidate, profile)
    graph_score, has_graph_evidence = await _graph_score(session, candidate, own_score)
    early_signal_score, token_history_count = await _early_signal_score(
        session,
        candidate,
        own_score,
    )
    recency_score = _recency_score(candidate, current_time)

    discovery_score = _clamp(
        relevance_score * 0.28
        + source_score * 0.16
        + graph_score * 0.18
        + engagement_score * 0.12
        + early_signal_score * 0.18
        + recency_score * 0.08
    )

    confidence = 0.0
    confidence += min(25.0, evidence_count * 5.0)
    confidence += min(20.0, source_type_count * 6.0)
    if resolved:
        confidence += 20.0
    if has_graph_evidence:
        confidence += 15.0
    if own_score is not None:
        confidence += 10.0
    if token_history_count > 0:
        confidence += min(10.0, 4.0 + token_history_count)

    return DiscoveryScoreBreakdown(
        discovery_score=round(discovery_score, 2),
        confidence=round(_clamp(confidence), 2),
        relevance_score=relevance_score,
        source_score=round(source_score, 2),
        graph_score=graph_score,
        engagement_score=engagement_score,
        early_signal_score=early_signal_score,
        recency_score=recency_score,
        evidence_count=evidence_count,
        source_type_count=source_type_count,
        resolved_profile=resolved,
        token_history_count=token_history_count,
    )


async def rescore_discovery_candidate(
    session: AsyncSession,
    candidate: TwitterDiscoveryCandidate,
    *,
    now: datetime | None = None,
) -> TwitterDiscoveryScore:
    breakdown = await calculate_discovery_score(session, candidate, now=now)
    row = await session.get(TwitterDiscoveryScore, candidate.id)
    if row is None:
        try:
            async with session.begin_nested():
                pending = TwitterDiscoveryScore(candidate_id=candidate.id)
                session.add(pending)
                await session.flush()
                row = pending
        except IntegrityError:
            row = await session.get(TwitterDiscoveryScore, candidate.id)
            if row is None:
                raise

    for field in (
        "discovery_score",
        "confidence",
        "relevance_score",
        "source_score",
        "graph_score",
        "engagement_score",
        "early_signal_score",
        "recency_score",
        "evidence_count",
        "source_type_count",
        "score_version",
    ):
        setattr(row, field, getattr(breakdown, field))
    row.scored_at = _aware(now or datetime.now(timezone.utc))
    row.components = asdict(breakdown)

    computed_priority = int(round(breakdown.discovery_score))
    if breakdown.resolved_profile or candidate.account_id is not None:
        candidate.priority = computed_priority
    else:
        candidate.priority = max(candidate.priority, computed_priority)
    await session.flush()
    return row


async def rescore_discovery_candidates(
    session: AsyncSession,
    *,
    statuses: tuple[str, ...] = ("queued", "retry", "processing", "accepted", "rejected"),
    limit: int = 1000,
) -> dict[str, float | int]:
    rows = list(
        (
            await session.execute(
                select(TwitterDiscoveryCandidate)
                .where(TwitterDiscoveryCandidate.status.in_(statuses))
                .order_by(TwitterDiscoveryCandidate.last_seen_at.desc())
                .limit(max(1, min(int(limit), 5000)))
            )
        ).scalars().all()
    )
    if not rows:
        return {"rescored": 0, "avg_score": 0.0, "avg_confidence": 0.0}

    score_total = 0.0
    confidence_total = 0.0
    now = datetime.now(timezone.utc)
    for candidate in rows:
        score = await rescore_discovery_candidate(session, candidate, now=now)
        score_total += score.discovery_score
        confidence_total += score.confidence

    count = len(rows)
    return {
        "rescored": count,
        "avg_score": round(score_total / count, 2),
        "avg_confidence": round(confidence_total / count, 2),
    }


async def top_discovery_candidates(
    session: AsyncSession,
    *,
    limit: int = 20,
) -> list[dict[str, Any]]:
    rows = (
        await session.execute(
            select(TwitterDiscoveryCandidate, TwitterDiscoveryScore)
            .join(
                TwitterDiscoveryScore,
                TwitterDiscoveryScore.candidate_id == TwitterDiscoveryCandidate.id,
            )
            .order_by(TwitterDiscoveryScore.discovery_score.desc())
            .limit(max(1, min(int(limit), 100)))
        )
    ).all()
    return [
        {
            "candidate_id": candidate.id,
            "twitter_id": candidate.twitter_id,
            "username": candidate.username,
            "status": candidate.status,
            "priority": candidate.priority,
            "depth": candidate.depth,
            "score": score.discovery_score,
            "confidence": score.confidence,
            "components": score.components,
        }
        for candidate, score in rows
    ]
