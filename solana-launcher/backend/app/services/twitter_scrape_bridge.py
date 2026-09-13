from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.twitter_account_registry import normalize_twitter_username
from app.services.twitter_discovery import enqueue_discovery_candidate
from app.services.twitter_discovery_scoring import rescore_discovery_candidate


def _timestamp(value: Any) -> datetime:
    now = datetime.now(UTC)
    if value is None:
        return now
    try:
        number = float(value)
    except (TypeError, ValueError):
        return now
    if number > 10_000_000_000:
        number /= 1000.0
    try:
        return datetime.fromtimestamp(number, tz=UTC)
    except (OverflowError, OSError, ValueError):
        return now


def _metric(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _safe_username(value: Any) -> str | None:
    try:
        return normalize_twitter_username(str(value or ""))
    except ValueError:
        return None


def _priority(tweet: dict[str, Any], shiller: dict[str, Any] | None) -> int:
    likes = _metric(tweet.get("likes"))
    reposts = _metric(tweet.get("retweets"))
    views = _metric(tweet.get("views"))
    engagement = likes + reposts * 2
    score = 62.0 + min(18.0, math.log10(engagement + 1) * 5.0)
    if views >= 10_000:
        score += 5.0
    if shiller and bool(shiller.get("isVerified")):
        score += 5.0
    if bool(tweet.get("isSuspicious")) or (shiller and bool(shiller.get("isBot"))):
        score -= 12.0
    return max(10, min(95, int(round(score))))


def _tweet_url(author: str, tweet_id: str) -> str:
    return f"https://x.com/{author}/status/{tweet_id}"


async def ingest_dev_twitter_stats(
    session: AsyncSession,
    payload: dict[str, Any],
    *,
    mint: str,
    symbol: str | None = None,
) -> dict[str, int]:
    """Ingest the existing Next.js /api/trade/dev-twitter response into discovery.

    This deliberately reuses the project's working Nitter/Playwright collector instead
    of implementing a second X scraper in the FastAPI service. Handles remain discovery
    candidates until a trustworthy stable numeric X id is available.
    """

    tweets = payload.get("topTweets")
    if not isinstance(tweets, list):
        tweets = []
    shillers_raw = payload.get("shillers")
    if not isinstance(shillers_raw, list):
        shillers_raw = []

    shillers: dict[str, dict[str, Any]] = {}
    for item in shillers_raw:
        if not isinstance(item, dict):
            continue
        handle = _safe_username(item.get("handle"))
        if handle:
            shillers[handle] = item

    unique_candidates: dict[int, Any] = {}
    evidence_seen = 0
    skipped = 0
    strategy = str(payload.get("collectionStrategy") or "unknown")[:64]
    clean_symbol = str(symbol or "").strip().lstrip("$")[:32] or None
    clean_mint = str(mint or "").strip()[:64]
    if not clean_mint:
        raise ValueError("mint must not be empty")
    query_hint = " OR ".join(
        value for value in ((f"${clean_symbol}" if clean_symbol else ""), clean_mint) if value
    )

    for raw in tweets:
        if not isinstance(raw, dict):
            skipped += 1
            continue
        author = _safe_username(raw.get("author"))
        tweet_id = str(raw.get("id") or "").strip()
        text = str(raw.get("text") or "").strip()
        if (
            not author
            or not tweet_id
            or len(tweet_id) > 32
            or not tweet_id.isdigit()
            or not text
        ):
            skipped += 1
            continue

        shiller = shillers.get(author)
        observed_at = _timestamp(raw.get("timestamp"))
        candidate = await enqueue_discovery_candidate(
            session,
            username=author,
            account_type_hint=(
                "trader" if shiller and _metric(shiller.get("tweets")) >= 2 else "unknown"
            ),
            priority=_priority(raw, shiller),
            depth=0,
            relevance_hint=55.0,
            source_type="x_search",
            source_ref=f"tweet:{tweet_id}",
            discovery_reason="token_search_tweet",
            query=query_hint or None,
            source_url=_tweet_url(author, tweet_id),
            observed_at=observed_at,
            evidence_raw={
                "collector": "dev-twitter",
                "strategy": strategy,
                "mint": clean_mint,
                "symbol": clean_symbol,
                "tweet": {
                    "id": tweet_id,
                    "text": text,
                    "author": author,
                    "likes": _metric(raw.get("likes")),
                    "retweets": _metric(raw.get("retweets")),
                    "views": _metric(raw.get("views")),
                    "timestamp": raw.get("timestamp"),
                    "isSuspicious": bool(raw.get("isSuspicious")),
                },
                "account": shiller or {},
            },
            meta={
                "last_tweet_id": tweet_id,
                "last_tweet_at": observed_at.isoformat(),
                "last_tweet_mint": clean_mint,
                "last_tweet_symbol": clean_symbol,
                "last_tweet_collector": strategy,
                "last_tweet_engagement": _metric(raw.get("likes"))
                + _metric(raw.get("retweets")),
                "last_tweet_suspicious": bool(raw.get("isSuspicious")),
                "last_account_bot": bool(shiller.get("isBot")) if shiller else False,
            },
        )
        unique_candidates[candidate.id] = candidate
        evidence_seen += 1

    for candidate in unique_candidates.values():
        await rescore_discovery_candidate(session, candidate)

    return {
        "tweets_seen": len(tweets),
        "evidence_processed": evidence_seen,
        "candidates_touched": len(unique_candidates),
        "skipped": skipped,
    }
