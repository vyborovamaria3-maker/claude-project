from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.twitter_intelligence import (
    TwitterAccount,
    TwitterAccountScore,
    TwitterAccountSnapshot,
    TwitterPost,
    TwitterPostToken,
)

_USERNAME_RE = re.compile(r"^[a-z0-9_]{1,15}$")


def _utcnow() -> datetime:
    return datetime.now(UTC)


def normalize_twitter_id(value: str | int) -> str:
    normalized = str(value).strip()
    if not normalized:
        raise ValueError("twitter_id must not be empty")
    if len(normalized) > 32:
        raise ValueError("twitter_id is too long")
    return normalized


def normalize_twitter_username(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    if normalized.startswith("@"):
        normalized = normalized[1:]
    normalized = normalized.strip().lower()
    if not normalized:
        return None
    if not _USERNAME_RE.fullmatch(normalized):
        raise ValueError("invalid X username")
    return normalized


def _metric(value: int) -> int:
    return max(0, int(value))


def _score(value: float) -> float:
    return round(max(0.0, min(100.0, float(value))), 4)


def _probability(value: float) -> float:
    return round(max(0.0, min(1.0, float(value))), 6)


def _clean(value: str | None, max_length: int) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned[:max_length] or None


def _profile_state(account: TwitterAccount) -> tuple[int, int, int, bool]:
    return (
        int(account.followers_count or 0),
        int(account.following_count or 0),
        int(account.tweet_count or 0),
        bool(account.verified),
    )


async def get_twitter_account(
    session: AsyncSession,
    twitter_id: str | int,
) -> TwitterAccount | None:
    normalized_id = normalize_twitter_id(twitter_id)
    return (
        await session.execute(
            select(TwitterAccount).where(TwitterAccount.twitter_id == normalized_id)
        )
    ).scalar_one_or_none()


async def record_twitter_account_snapshot(
    session: AsyncSession,
    account: TwitterAccount,
    *,
    captured_at: datetime | None = None,
    source: str | None = None,
    raw: dict[str, Any] | None = None,
) -> TwitterAccountSnapshot:
    snapshot = TwitterAccountSnapshot(
        account_id=account.id,
        followers_count=account.followers_count,
        following_count=account.following_count,
        tweet_count=account.tweet_count,
        verified=account.verified,
        captured_at=captured_at or _utcnow(),
        source=_clean(source or account.source, 64) or "unknown",
        raw=raw,
    )
    session.add(snapshot)
    await session.flush()
    return snapshot


async def upsert_twitter_account(
    session: AsyncSession,
    *,
    twitter_id: str | int,
    username: str | None = None,
    display_name: str | None = None,
    bio: str | None = None,
    avatar_url: str | None = None,
    followers_count: int | None = None,
    following_count: int | None = None,
    tweet_count: int | None = None,
    verified: bool | None = None,
    x_created_at: datetime | None = None,
    account_type: str | None = None,
    status: str | None = None,
    observed_at: datetime | None = None,
    synced_at: datetime | None = None,
    source: str = "unknown",
    raw: dict[str, Any] | None = None,
    record_snapshot: bool = True,
) -> TwitterAccount:
    now = observed_at or _utcnow()
    normalized_id = normalize_twitter_id(twitter_id)
    normalized_username = normalize_twitter_username(username)
    account = await get_twitter_account(session, normalized_id)
    created = account is None

    if account is None:
        try:
            async with session.begin_nested():
                pending = TwitterAccount(
                    twitter_id=normalized_id,
                    first_seen_at=now,
                    last_seen_at=now,
                    source=_clean(source, 64) or "unknown",
                )
                session.add(pending)
                await session.flush()
                account = pending
        except IntegrityError:
            account = await get_twitter_account(session, normalized_id)
            created = False
            if account is None:
                raise

    previous_profile = _profile_state(account)

    if username is not None:
        account.username = normalized_username
    if display_name is not None:
        account.display_name = _clean(display_name, 255)
    if bio is not None:
        account.bio = bio
    if avatar_url is not None:
        account.avatar_url = _clean(avatar_url, 1024)
    if followers_count is not None:
        account.followers_count = _metric(followers_count)
    if following_count is not None:
        account.following_count = _metric(following_count)
    if tweet_count is not None:
        account.tweet_count = _metric(tweet_count)
    if verified is not None:
        account.verified = bool(verified)
    if x_created_at is not None:
        account.x_created_at = x_created_at
    if account_type is not None:
        account.account_type = _clean(account_type.lower(), 32) or "unknown"
    if status is not None:
        account.status = _clean(status.lower(), 24) or "active"

    account.last_seen_at = now
    account.last_profile_sync_at = synced_at or now
    account.source = _clean(source, 64) or "unknown"
    if raw is not None:
        account.raw = raw

    await session.flush()
    profile_changed = previous_profile != _profile_state(account)

    if record_snapshot or created or profile_changed:
        await record_twitter_account_snapshot(
            session,
            account,
            captured_at=synced_at or now,
            source=source,
            raw=raw,
        )
    return account


async def upsert_twitter_account_score(
    session: AsyncSession,
    *,
    account_id: int,
    influence_score: float | None = None,
    trust_score: float | None = None,
    alpha_score: float | None = None,
    shill_score: float | None = None,
    bot_score: float | None = None,
    crypto_relevance_score: float | None = None,
    solana_relevance_score: float | None = None,
    score_confidence: float | None = None,
    score_source: str = "unknown",
    model_version: str | None = None,
    meta: dict[str, Any] | None = None,
) -> TwitterAccountScore:
    score = await session.get(TwitterAccountScore, account_id)
    if score is None:
        try:
            async with session.begin_nested():
                pending = TwitterAccountScore(account_id=account_id)
                session.add(pending)
                await session.flush()
                score = pending
        except IntegrityError:
            score = await session.get(TwitterAccountScore, account_id)
            if score is None:
                raise

    values = {
        "influence_score": influence_score,
        "trust_score": trust_score,
        "alpha_score": alpha_score,
        "shill_score": shill_score,
        "bot_score": bot_score,
        "crypto_relevance_score": crypto_relevance_score,
        "solana_relevance_score": solana_relevance_score,
        "score_confidence": score_confidence,
    }
    for field, value in values.items():
        if value is not None:
            setattr(score, field, _score(value))

    score.score_source = _clean(score_source, 64) or "unknown"
    score.model_version = _clean(model_version, 128)
    score.updated_at = _utcnow()
    if meta is not None:
        score.meta = meta
    await session.flush()
    return score


async def upsert_twitter_post(
    session: AsyncSession,
    *,
    account_id: int,
    twitter_post_id: str | int,
    published_at: datetime,
    text: str | None = None,
    likes: int | None = None,
    replies: int | None = None,
    reposts: int | None = None,
    quotes: int | None = None,
    views: int | None = None,
    language: str | None = None,
    sentiment: float | None = None,
    crypto_relevance: float | None = None,
    spam_probability: float | None = None,
    source_url: str | None = None,
    source: str = "unknown",
    raw: dict[str, Any] | None = None,
) -> TwitterPost:
    normalized_post_id = normalize_twitter_id(twitter_post_id)
    post = (
        await session.execute(
            select(TwitterPost).where(TwitterPost.twitter_post_id == normalized_post_id)
        )
    ).scalar_one_or_none()
    now = _utcnow()

    if post is None:
        try:
            async with session.begin_nested():
                pending = TwitterPost(
                    twitter_post_id=normalized_post_id,
                    account_id=account_id,
                    published_at=published_at,
                    source=_clean(source, 64) or "unknown",
                    created_at=now,
                    updated_at=now,
                )
                session.add(pending)
                await session.flush()
                post = pending
        except IntegrityError:
            post = (
                await session.execute(
                    select(TwitterPost).where(TwitterPost.twitter_post_id == normalized_post_id)
                )
            ).scalar_one_or_none()
            if post is None:
                raise
    if post.account_id != account_id:
        raise ValueError("twitter_post_id is already owned by another account")

    post.published_at = published_at
    if text is not None:
        post.text = text
    if likes is not None:
        post.likes = _metric(likes)
    if replies is not None:
        post.replies = _metric(replies)
    if reposts is not None:
        post.reposts = _metric(reposts)
    if quotes is not None:
        post.quotes = _metric(quotes)
    if views is not None:
        post.views = _metric(views)
    if language is not None:
        post.language = _clean(language.lower(), 16)
    if sentiment is not None:
        post.sentiment = float(sentiment)
    if crypto_relevance is not None:
        post.crypto_relevance = _score(crypto_relevance)
    if spam_probability is not None:
        post.spam_probability = _probability(spam_probability)
    if source_url is not None:
        post.source_url = _clean(source_url, 512)
    post.source = _clean(source, 64) or "unknown"
    post.updated_at = now
    if raw is not None:
        post.raw = raw

    await session.flush()
    return post


async def link_twitter_post_token(
    session: AsyncSession,
    *,
    post: TwitterPost,
    mint_address: str,
    symbol: str | None = None,
    mention_type: str = "mention",
    confidence: float = 1.0,
    first_seen_at: datetime | None = None,
    meta: dict[str, Any] | None = None,
) -> TwitterPostToken:
    mint = mint_address.strip()
    if not mint:
        raise ValueError("mint_address must not be empty")
    mint = mint[:64]

    link = (
        await session.execute(
            select(TwitterPostToken).where(
                TwitterPostToken.post_id == post.id,
                TwitterPostToken.mint_address == mint,
            )
        )
    ).scalar_one_or_none()

    if link is None:
        try:
            async with session.begin_nested():
                pending = TwitterPostToken(
                    post_id=post.id,
                    account_id=post.account_id,
                    mint_address=mint,
                    first_seen_at=first_seen_at or post.published_at,
                )
                session.add(pending)
                await session.flush()
                link = pending
        except IntegrityError:
            link = (
                await session.execute(
                    select(TwitterPostToken).where(
                        TwitterPostToken.post_id == post.id,
                        TwitterPostToken.mint_address == mint,
                    )
                )
            ).scalar_one_or_none()
            if link is None:
                raise

    if symbol is not None:
        link.symbol = _clean(symbol.upper(), 32)
    link.mention_type = _clean(mention_type.lower(), 24) or "mention"
    link.confidence = max(0.0, min(1.0, float(confidence)))
    if meta is not None:
        link.meta = meta
    await session.flush()
    return link
