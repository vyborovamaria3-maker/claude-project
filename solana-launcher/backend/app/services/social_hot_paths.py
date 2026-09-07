from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.social_intelligence import (
    SocialEvent,
    TelegramChannel,
    TelegramChannelScore,
)
from app.services.social_filters import normalize_social_source


def _tweet_timestamp(value: Any) -> datetime | None:
    if isinstance(value, (int, float)):
        seconds = value / 1000 if value > 10_000_000_000 else value
        return datetime.fromtimestamp(seconds, tz=timezone.utc)
    return None


def _tweet_metrics(tweet: dict[str, Any]) -> dict[str, Any]:
    suspicion_score = float(tweet.get("suspicion_score") or 0)
    return {
        "views": int(tweet.get("views") or 0),
        "likes": int(tweet.get("likes") or 0),
        "retweets": int(tweet.get("retweets") or 0),
        "replies": int(tweet.get("replies") or 0),
        "verified": bool(tweet.get("is_verified")),
        "suspicion_score": tweet.get("suspicion_score"),
        "suspicious": suspicion_score >= 50.0,
    }


async def ingest_x_events_bulk(
    session: AsyncSession,
    payload: dict[str, Any],
) -> dict[str, int]:
    """Persist one X refresh with a single existing-row lookup instead of N queries."""
    mint = str(payload.get("token_mint") or "").strip() or None
    symbol = str(payload.get("token_symbol") or "").strip() or None
    strategy = payload.get("strategy")

    prepared: dict[str, tuple[dict[str, Any], datetime]] = {}
    skipped_missing_timestamp = 0
    for tweet in payload.get("tweets") or []:
        if not isinstance(tweet, dict):
            continue
        external_id = str(tweet.get("id") or "").strip()
        if not external_id:
            continue
        occurred_at = _tweet_timestamp(tweet.get("posted_at"))
        if occurred_at is None:
            skipped_missing_timestamp += 1
            continue
        # A provider can repeat a tweet in the same payload. Last observation wins and
        # the database never receives duplicate work for the same external id.
        prepared[external_id] = (tweet, occurred_at)

    if not prepared:
        return {
            "inserted": 0,
            "updated": 0,
            "skipped_missing_timestamp": skipped_missing_timestamp,
        }

    external_ids = list(prepared)
    existing_rows = list(
        (
            await session.execute(
                select(SocialEvent).where(
                    SocialEvent.platform == "x",
                    SocialEvent.event_type == "token_mention",
                    SocialEvent.mint_address == mint,
                    SocialEvent.external_id.in_(external_ids),
                )
            )
        ).scalars().all()
    )
    existing_by_id = {row.external_id: row for row in existing_rows}

    inserted = 0
    updated = 0
    for external_id, (tweet, occurred_at) in prepared.items():
        metrics = _tweet_metrics(tweet)
        existing = existing_by_id.get(external_id)
        if existing is None:
            session.add(
                SocialEvent(
                    platform="x",
                    event_type="token_mention",
                    external_id=external_id,
                    source_handle=tweet.get("author_handle"),
                    source_name=tweet.get("author_display_name"),
                    source_url=tweet.get("url"),
                    mint_address=mint,
                    symbol=symbol,
                    text=str(tweet.get("text") or ""),
                    occurred_at=occurred_at,
                    metrics=metrics,
                    payload={"strategy": strategy},
                )
            )
            inserted += 1
            continue

        existing.source_handle = tweet.get("author_handle") or existing.source_handle
        existing.source_name = tweet.get("author_display_name") or existing.source_name
        existing.source_url = tweet.get("url") or existing.source_url
        existing.text = str(tweet.get("text") or existing.text)
        existing.occurred_at = occurred_at
        existing.metrics = metrics
        existing.payload = {"strategy": strategy}
        updated += 1

    await session.commit()
    return {
        "inserted": inserted,
        "updated": updated,
        "skipped_missing_timestamp": skipped_missing_timestamp,
    }


async def channel_score_lookup(
    session: AsyncSession,
    *,
    min_score: float = 0.0,
) -> dict[str, float]:
    """Load the score lookup in one narrow query rather than paging full channel rows."""
    statement = (
        select(
            TelegramChannel.username,
            TelegramChannel.telegram_id,
            TelegramChannelScore.score,
        )
        .join(
            TelegramChannelScore,
            TelegramChannelScore.channel_id == TelegramChannel.id,
        )
        .where(TelegramChannelScore.score >= max(0.0, float(min_score)))
    )
    rows = (await session.execute(statement)).all()
    result: dict[str, float] = {}
    for username, telegram_id, score in rows:
        value = float(score or 0.0)
        if username:
            result[normalize_social_source(str(username))] = value
        if telegram_id is not None:
            result[normalize_social_source(str(telegram_id))] = value
    return result


async def token_timeline_candidates(
    session: AsyncSession,
    mint_address: str,
    *,
    platform: str | None = None,
    hours: int | None = None,
) -> dict[str, Any]:
    """Push stable timeline filters into SQL before Python-only social filtering."""
    statement = select(SocialEvent).where(SocialEvent.mint_address == mint_address)
    if platform:
        statement = statement.where(SocialEvent.platform == platform.lower())
    if hours is not None:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=max(1, int(hours)))
        statement = statement.where(SocialEvent.occurred_at >= cutoff)

    events = list(
        (
            await session.execute(statement.order_by(SocialEvent.occurred_at.asc()))
        ).scalars().all()
    )
    platforms: defaultdict[str, int] = defaultdict(int)
    timeline: list[dict[str, Any]] = []
    for index, event in enumerate(events):
        platforms[event.platform] += 1
        timeline.append(
            {
                "rank": index + 1,
                "platform": event.platform,
                "event_type": event.event_type,
                "source_handle": event.source_handle,
                "source_name": event.source_name,
                "source_url": event.source_url,
                "text": event.text,
                "occurred_at": event.occurred_at,
                "metrics": event.metrics,
            }
        )
    return {
        "mint_address": mint_address,
        "mentions": len(events),
        "platforms": dict(platforms),
        "origin": timeline[0] if timeline else None,
        "timeline": timeline,
    }
