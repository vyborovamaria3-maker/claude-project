from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.twitter_intelligence import (
    TwitterDiscoveryCandidate,
    TwitterDiscoveryEvidence,
)
from app.services.twitter_account_registry import (
    normalize_twitter_id,
    normalize_twitter_username,
    upsert_twitter_account,
)


CRYPTO_TERMS: dict[str, float] = {
    "crypto": 22.0,
    "bitcoin": 12.0,
    "ethereum": 10.0,
    "web3": 12.0,
    "defi": 16.0,
    "token": 10.0,
    "trading": 8.0,
    "trader": 10.0,
    "onchain": 18.0,
    "on-chain": 18.0,
    "blockchain": 10.0,
    "dex": 12.0,
    "airdrop": 10.0,
    "nft": 8.0,
    "altcoin": 12.0,
    "market maker": 18.0,
    "venture": 6.0,
}

MEME_SOLANA_TERMS: dict[str, float] = {
    "solana": 34.0,
    "$sol": 24.0,
    "memecoin": 34.0,
    "meme coin": 34.0,
    "meme": 12.0,
    "pump.fun": 36.0,
    "pumpfun": 36.0,
    "degen": 20.0,
    "launchpad": 18.0,
    "raydium": 28.0,
    "jupiter": 20.0,
    "meteora": 24.0,
    "orca": 18.0,
    "bonk": 20.0,
    "wif": 16.0,
    "rug": 12.0,
    "smart money": 14.0,
    "alpha": 8.0,
}

MEDIA_TERMS = (
    "journalist",
    "reporter",
    "editor",
    "news",
    "media",
    "podcast",
    "newsletter",
    "research",
    "analyst",
)


@dataclass(slots=True)
class ResolvedTwitterProfile:
    twitter_id: str
    username: str | None = None
    display_name: str | None = None
    bio: str = ""
    avatar_url: str | None = None
    followers_count: int = 0
    following_count: int = 0
    tweet_count: int = 0
    verified: bool = False
    x_created_at: datetime | None = None
    source: str = "unknown"
    raw: dict[str, Any] | None = None


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def clamp_int(value: int, low: int, high: int) -> int:
    return max(low, min(high, int(value)))


def clamp_float(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, float(value)))


def candidate_key(*, twitter_id: str | int | None, username: str | None) -> str:
    if twitter_id is not None and str(twitter_id).strip():
        return f"id:{normalize_twitter_id(twitter_id)}"
    normalized_username = normalize_twitter_username(username)
    if normalized_username:
        return f"username:{normalized_username}"
    raise ValueError("candidate requires twitter_id or username")


def profile_relevance_score(
    profile: ResolvedTwitterProfile,
    *,
    relevance_hint: float = 0.0,
) -> float:
    text = " ".join(
        part
        for part in (
            profile.username or "",
            profile.display_name or "",
            profile.bio or "",
        )
        if part
    ).lower()
    score = 0.0
    for term, weight in CRYPTO_TERMS.items():
        if term in text:
            score += weight
    for term, weight in MEME_SOLANA_TERMS.items():
        if term in text:
            score += weight
    if any(term in text for term in MEDIA_TERMS) and score >= 10.0:
        score += 15.0
    if profile.followers_count >= 100_000:
        score += 6.0
    elif profile.followers_count >= 10_000:
        score += 3.0
    return round(clamp_float(max(score, relevance_hint)), 2)


def solana_relevance_score(profile: ResolvedTwitterProfile) -> float:
    text = " ".join(
        part
        for part in (
            profile.username or "",
            profile.display_name or "",
            profile.bio or "",
        )
        if part
    ).lower()
    score = sum(weight for term, weight in MEME_SOLANA_TERMS.items() if term in text)
    return round(clamp_float(score), 2)


def classify_account_type(
    profile: ResolvedTwitterProfile,
    *,
    hint: str | None = None,
) -> str:
    normalized_hint = (hint or "").strip().lower()
    if normalized_hint and normalized_hint != "unknown":
        return normalized_hint[:32]

    text = " ".join(
        part
        for part in (
            profile.username or "",
            profile.display_name or "",
            profile.bio or "",
        )
        if part
    ).lower()
    if any(term in text for term in ("journalist", "reporter", "editor", "news", "media")):
        return "media"
    if any(term in text for term in ("exchange", "cex", "spot trading", "futures")):
        return "exchange"
    if any(term in text for term in ("venture", "capital", "vc fund", "investment fund")):
        return "fund"
    if any(term in text for term in ("market maker", "liquidity provider")):
        return "market_maker"
    if any(term in text for term in ("dex", "amm", "launchpad")):
        return "protocol"
    if any(term in text for term in ("developer", "engineer", "builder", "founder")):
        return "builder"
    if any(term in text for term in ("research", "analyst", "analytics", "onchain")):
        return "research"
    if any(term in text for term in ("trader", "trading", "alpha", "degen")):
        return "trader"
    return "unknown"


def profile_to_meta(profile: ResolvedTwitterProfile) -> dict[str, Any]:
    data = asdict(profile)
    if profile.x_created_at is not None:
        data["x_created_at"] = profile.x_created_at.isoformat()
    return data


def profile_from_meta(value: dict[str, Any] | None) -> ResolvedTwitterProfile | None:
    if not isinstance(value, dict):
        return None
    payload = value.get("resolved_profile")
    if not isinstance(payload, dict) or not payload.get("twitter_id"):
        return None
    created_at = payload.get("x_created_at")
    parsed_created_at: datetime | None = None
    if isinstance(created_at, str) and created_at:
        try:
            parsed_created_at = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        except ValueError:
            parsed_created_at = None
    return ResolvedTwitterProfile(
        twitter_id=str(payload["twitter_id"]),
        username=payload.get("username"),
        display_name=payload.get("display_name"),
        bio=str(payload.get("bio") or ""),
        avatar_url=payload.get("avatar_url"),
        followers_count=int(payload.get("followers_count") or 0),
        following_count=int(payload.get("following_count") or 0),
        tweet_count=int(payload.get("tweet_count") or 0),
        verified=bool(payload.get("verified")),
        x_created_at=parsed_created_at,
        source=str(payload.get("source") or "unknown"),
        raw=payload.get("raw") if isinstance(payload.get("raw"), dict) else None,
    )


def _clean_ref(value: str | None, max_length: int) -> str:
    return (value or "").strip()[:max_length]


async def _canonical_candidate(
    session: AsyncSession,
    candidate: TwitterDiscoveryCandidate | None,
) -> TwitterDiscoveryCandidate | None:
    seen: set[int] = set()
    current = candidate
    while current is not None and current.status == "duplicate" and current.id not in seen:
        seen.add(current.id)
        marker = str(current.last_error or "")
        if not marker.startswith("merged_into_candidate:"):
            break
        try:
            target_id = int(marker.split(":", 1)[1])
        except (TypeError, ValueError):
            break
        target = await session.get(TwitterDiscoveryCandidate, target_id)
        if target is None:
            break
        current = target
    return current


async def _find_candidate(
    session: AsyncSession,
    *,
    normalized_id: str | None,
    normalized_username: str | None,
    key: str,
) -> TwitterDiscoveryCandidate | None:
    candidate: TwitterDiscoveryCandidate | None = None
    if normalized_id is not None:
        candidate = (
            await session.execute(
                select(TwitterDiscoveryCandidate).where(
                    TwitterDiscoveryCandidate.twitter_id == normalized_id
                )
            )
        ).scalar_one_or_none()
    if candidate is None and normalized_username is not None:
        candidate = (
            await session.execute(
                select(TwitterDiscoveryCandidate)
                .where(TwitterDiscoveryCandidate.username == normalized_username)
                .order_by(TwitterDiscoveryCandidate.id.asc())
            )
        ).scalars().first()
    if candidate is None:
        candidate = (
            await session.execute(
                select(TwitterDiscoveryCandidate).where(
                    TwitterDiscoveryCandidate.candidate_key == key
                )
            )
        ).scalar_one_or_none()
    return await _canonical_candidate(session, candidate)


async def _ensure_evidence(
    session: AsyncSession,
    *,
    candidate_id: int,
    source_type: str,
    source_ref: str,
    discovery_reason: str,
    query: str | None,
    source_url: str | None,
    observed_at: datetime,
    raw: dict[str, Any] | None,
) -> None:
    existing = (
        await session.execute(
            select(TwitterDiscoveryEvidence).where(
                TwitterDiscoveryEvidence.candidate_id == candidate_id,
                TwitterDiscoveryEvidence.source_type == source_type,
                TwitterDiscoveryEvidence.source_ref == source_ref,
                TwitterDiscoveryEvidence.discovery_reason == discovery_reason,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        if _as_utc(observed_at) < _as_utc(existing.observed_at):
            existing.observed_at = observed_at
        if existing.query is None and query:
            existing.query = query
        if existing.source_url is None and source_url:
            existing.source_url = source_url
        if existing.raw is None and raw is not None:
            existing.raw = raw
        return

    try:
        async with session.begin_nested():
            session.add(
                TwitterDiscoveryEvidence(
                    candidate_id=candidate_id,
                    source_type=source_type,
                    source_ref=source_ref,
                    discovery_reason=discovery_reason,
                    query=query,
                    source_url=source_url,
                    observed_at=observed_at,
                    raw=raw,
                )
            )
            await session.flush()
    except IntegrityError:
        return


async def enqueue_discovery_candidate(
    session: AsyncSession,
    *,
    twitter_id: str | int | None = None,
    username: str | None = None,
    display_name: str | None = None,
    account_type_hint: str = "unknown",
    priority: int = 50,
    depth: int = 0,
    relevance_hint: float = 0.0,
    parent_account_id: int | None = None,
    source_type: str,
    source_ref: str = "",
    discovery_reason: str = "unknown",
    query: str | None = None,
    source_url: str | None = None,
    observed_at: datetime | None = None,
    evidence_raw: dict[str, Any] | None = None,
    meta: dict[str, Any] | None = None,
) -> TwitterDiscoveryCandidate:
    now = observed_at or utcnow()
    normalized_id = (
        normalize_twitter_id(twitter_id)
        if twitter_id is not None and str(twitter_id).strip()
        else None
    )
    normalized_username = normalize_twitter_username(username)
    key = candidate_key(twitter_id=normalized_id, username=normalized_username)

    candidate = await _find_candidate(
        session,
        normalized_id=normalized_id,
        normalized_username=normalized_username,
        key=key,
    )
    if candidate is None:
        try:
            async with session.begin_nested():
                pending = TwitterDiscoveryCandidate(
                    candidate_key=key,
                    twitter_id=normalized_id,
                    username=normalized_username,
                    display_name=(display_name or "").strip()[:255] or None,
                    account_type_hint=(account_type_hint or "unknown").strip().lower()[:32],
                    status="queued",
                    priority=clamp_int(priority, 0, 100),
                    depth=max(0, int(depth)),
                    relevance_hint=clamp_float(relevance_hint),
                    parent_account_id=parent_account_id,
                    first_seen_at=now,
                    last_seen_at=now,
                    meta=dict(meta or {}),
                )
                session.add(pending)
                await session.flush()
                candidate = pending
        except IntegrityError:
            candidate = await _find_candidate(
                session,
                normalized_id=normalized_id,
                normalized_username=normalized_username,
                key=key,
            )
            if candidate is None:
                raise

    if normalized_id is not None and candidate.twitter_id is None:
        original_candidate = candidate
        try:
            async with session.begin_nested():
                candidate.twitter_id = normalized_id
                await session.flush()
        except IntegrityError:
            conflict = await _find_candidate(
                session,
                normalized_id=normalized_id,
                normalized_username=None,
                key=f"id:{normalized_id}",
            )
            if conflict is None:
                raise
            if conflict.id != original_candidate.id:
                await _merge_candidate_evidence(
                    session,
                    source_candidate=original_candidate,
                    target_candidate=conflict,
                )
                original_candidate.status = "duplicate"
                original_candidate.last_error = f"merged_into_candidate:{conflict.id}"
                original_candidate.next_attempt_at = None
                original_candidate.lease_owner = None
                original_candidate.lease_expires_at = None
            candidate = conflict
    if normalized_username is not None and (
        candidate.twitter_id is None or normalized_id is not None
    ):
        candidate.username = normalized_username
    if display_name is not None and (
        candidate.twitter_id is None or normalized_id is not None
    ):
        candidate.display_name = display_name.strip()[:255] or None
    if account_type_hint and account_type_hint != "unknown":
        candidate.account_type_hint = account_type_hint.strip().lower()[:32]
    candidate.priority = max(candidate.priority, clamp_int(priority, 0, 100))
    candidate.depth = min(candidate.depth, max(0, int(depth)))
    candidate.relevance_hint = max(candidate.relevance_hint, clamp_float(relevance_hint))
    if parent_account_id is not None and candidate.parent_account_id is None:
        candidate.parent_account_id = parent_account_id
    if _as_utc(now) > _as_utc(candidate.last_seen_at):
        candidate.last_seen_at = now
    if meta:
        candidate.meta = {**(candidate.meta or {}), **meta}
    if candidate.status in {"rejected", "dead"} and relevance_hint >= 70.0:
        candidate.status = "queued"
        candidate.next_attempt_at = None
        candidate.last_error = None
    await session.flush()

    evidence_type = _clean_ref(source_type, 48) or "unknown"
    evidence_ref = _clean_ref(source_ref, 512)
    evidence_reason = _clean_ref(discovery_reason, 96) or "unknown"
    await _ensure_evidence(
        session,
        candidate_id=candidate.id,
        source_type=evidence_type,
        source_ref=evidence_ref,
        discovery_reason=evidence_reason,
        query=query,
        source_url=_clean_ref(source_url, 1024) or None,
        observed_at=now,
        raw=evidence_raw,
    )
    return candidate


async def _merge_candidate_evidence(
    session: AsyncSession,
    *,
    source_candidate: TwitterDiscoveryCandidate,
    target_candidate: TwitterDiscoveryCandidate,
) -> None:
    rows = list(
        (
            await session.execute(
                select(TwitterDiscoveryEvidence).where(
                    TwitterDiscoveryEvidence.candidate_id == source_candidate.id
                )
            )
        ).scalars().all()
    )
    for evidence in rows:
        await _ensure_evidence(
            session,
            candidate_id=target_candidate.id,
            source_type=evidence.source_type,
            source_ref=evidence.source_ref,
            discovery_reason=evidence.discovery_reason,
            query=evidence.query,
            source_url=evidence.source_url,
            observed_at=evidence.observed_at,
            raw=evidence.raw,
        )


async def attach_resolved_profile(
    session: AsyncSession,
    candidate: TwitterDiscoveryCandidate,
    profile: ResolvedTwitterProfile,
) -> TwitterDiscoveryCandidate:
    normalized_id = normalize_twitter_id(profile.twitter_id)
    normalized_username = normalize_twitter_username(profile.username)
    conflict = (
        await session.execute(
            select(TwitterDiscoveryCandidate).where(
                TwitterDiscoveryCandidate.twitter_id == normalized_id,
                TwitterDiscoveryCandidate.id != candidate.id,
            )
        )
    ).scalar_one_or_none()
    conflict = await _canonical_candidate(session, conflict)
    if conflict is not None and conflict.id != candidate.id:
        await _merge_candidate_evidence(
            session,
            source_candidate=candidate,
            target_candidate=conflict,
        )
        conflict.priority = max(conflict.priority, candidate.priority)
        conflict.relevance_hint = max(conflict.relevance_hint, candidate.relevance_hint)
        conflict.depth = min(conflict.depth, candidate.depth)
        if _as_utc(candidate.first_seen_at) < _as_utc(conflict.first_seen_at):
            conflict.first_seen_at = candidate.first_seen_at
        if _as_utc(candidate.last_seen_at) > _as_utc(conflict.last_seen_at):
            conflict.last_seen_at = candidate.last_seen_at
        if conflict.parent_account_id is None and candidate.parent_account_id is not None:
            conflict.parent_account_id = candidate.parent_account_id
        if normalized_username is not None:
            conflict.username = normalized_username
        if profile.display_name:
            conflict.display_name = profile.display_name.strip()[:255]
        conflict.meta = {
            **(conflict.meta or {}),
            **(candidate.meta or {}),
            "resolved_profile": profile_to_meta(profile),
        }
        candidate.status = "duplicate"
        candidate.last_error = f"merged_into_candidate:{conflict.id}"
        candidate.next_attempt_at = None
        candidate.lease_owner = None
        candidate.lease_expires_at = None
        await session.flush()
        return conflict

    try:
        async with session.begin_nested():
            candidate.twitter_id = normalized_id
            if normalized_username is not None:
                candidate.username = normalized_username
            if profile.display_name:
                candidate.display_name = profile.display_name.strip()[:255]
            candidate.meta = {
                **(candidate.meta or {}),
                "resolved_profile": profile_to_meta(profile),
            }
            await session.flush()
    except IntegrityError:
        conflict = (
            await session.execute(
                select(TwitterDiscoveryCandidate).where(
                    TwitterDiscoveryCandidate.twitter_id == normalized_id
                )
            )
        ).scalar_one_or_none()
        conflict = await _canonical_candidate(session, conflict)
        if conflict is None or conflict.id == candidate.id:
            raise
        return await attach_resolved_profile(session, candidate, profile)
    return candidate


async def claim_discovery_candidates(
    session: AsyncSession,
    *,
    worker_id: str,
    limit: int = 25,
    lease_seconds: int = 300,
) -> list[TwitterDiscoveryCandidate]:
    now = utcnow()
    available = or_(
        TwitterDiscoveryCandidate.status.in_(("queued", "retry")),
        and_(
            TwitterDiscoveryCandidate.status == "processing",
            TwitterDiscoveryCandidate.lease_expires_at.is_not(None),
            TwitterDiscoveryCandidate.lease_expires_at <= now,
        ),
    )
    stmt = (
        select(TwitterDiscoveryCandidate)
        .where(
            available,
            or_(
                TwitterDiscoveryCandidate.next_attempt_at.is_(None),
                TwitterDiscoveryCandidate.next_attempt_at <= now,
            ),
        )
        .order_by(
            TwitterDiscoveryCandidate.priority.desc(),
            TwitterDiscoveryCandidate.depth.asc(),
            TwitterDiscoveryCandidate.id.asc(),
        )
        .limit(max(1, min(int(limit), 500)))
        .with_for_update(skip_locked=True)
    )
    rows = list((await session.execute(stmt)).scalars().all())
    lease_until = now + timedelta(seconds=max(30, int(lease_seconds)))
    for candidate in rows:
        candidate.status = "processing"
        candidate.lease_owner = worker_id[:128]
        candidate.lease_expires_at = lease_until
        candidate.last_attempt_at = now
        candidate.attempts += 1
    await session.flush()
    return rows


async def mark_candidate_failed(
    session: AsyncSession,
    candidate: TwitterDiscoveryCandidate,
    *,
    error: str,
    base_backoff_seconds: int = 60,
    max_attempts: int = 8,
) -> None:
    candidate.lease_owner = None
    candidate.lease_expires_at = None
    candidate.last_error = error[:4000]
    if candidate.attempts >= max_attempts:
        candidate.status = "dead"
        candidate.next_attempt_at = None
    else:
        exponent = max(0, min(candidate.attempts - 1, 8))
        delay = min(6 * 3600, max(30, base_backoff_seconds) * (2**exponent))
        candidate.status = "retry"
        candidate.next_attempt_at = utcnow() + timedelta(seconds=delay)
    await session.flush()


async def reject_candidate(
    session: AsyncSession,
    candidate: TwitterDiscoveryCandidate,
    *,
    reason: str,
) -> None:
    candidate.status = "rejected"
    candidate.last_error = reason[:4000]
    candidate.lease_owner = None
    candidate.lease_expires_at = None
    candidate.next_attempt_at = None
    await session.flush()


async def promote_candidate(
    session: AsyncSession,
    candidate: TwitterDiscoveryCandidate,
    profile: ResolvedTwitterProfile,
    *,
    min_relevance: float = 35.0,
) -> tuple[bool, int | None, float]:
    candidate = await attach_resolved_profile(session, candidate, profile)
    relevance = profile_relevance_score(
        profile,
        relevance_hint=candidate.relevance_hint,
    )
    candidate.relevance_hint = relevance
    if relevance < min_relevance:
        await reject_candidate(
            session,
            candidate,
            reason=f"relevance_below_threshold:{relevance:.2f}",
        )
        return False, None, relevance

    account_type = classify_account_type(profile, hint=candidate.account_type_hint)
    record_snapshot = candidate.account_id is None
    account = await upsert_twitter_account(
        session,
        twitter_id=profile.twitter_id,
        username=profile.username,
        display_name=profile.display_name,
        bio=profile.bio,
        avatar_url=profile.avatar_url,
        followers_count=profile.followers_count,
        following_count=profile.following_count,
        tweet_count=profile.tweet_count,
        verified=profile.verified,
        x_created_at=profile.x_created_at,
        account_type=account_type,
        status="active",
        source=profile.source or "twitter_discovery",
        raw=profile.raw,
        record_snapshot=record_snapshot,
    )
    candidate.account_id = account.id
    candidate.account_type_hint = account_type
    candidate.status = "accepted"
    candidate.last_error = None
    candidate.next_attempt_at = None
    candidate.lease_owner = None
    candidate.lease_expires_at = None
    candidate.meta = {
        **(candidate.meta or {}),
        "relevance_score": relevance,
        "solana_relevance_score": solana_relevance_score(profile),
    }
    await session.flush()
    return True, account.id, relevance


async def discovery_stats(session: AsyncSession) -> dict[str, int]:
    rows = (
        await session.execute(
            select(
                TwitterDiscoveryCandidate.status,
                func.count(TwitterDiscoveryCandidate.id),
            ).group_by(TwitterDiscoveryCandidate.status)
        )
    ).all()
    result = {str(status): int(count) for status, count in rows}
    result["total"] = sum(result.values())
    return result
