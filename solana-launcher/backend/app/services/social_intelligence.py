from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from statistics import mean
from typing import Any

import httpx
from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analytics import Token, TokenMetric
from app.models.social_intelligence import (
    SocialEvent,
    SocialRelation,
    TelegramCall,
    TelegramChannel,
    TelegramChannelScore,
)

CALL_BASELINE_LOOKBACK = timedelta(minutes=90)


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def score_channel_metrics(
    *,
    calls: int,
    evaluated: int,
    wins: int,
    rugs: int,
    early: int,
    avg_roi: float,
) -> float:
    if calls <= 0:
        return 0.0
    experience = min(calls / 20.0, 1.0)
    evaluation_confidence = min(evaluated / 10.0, 1.0)
    win_rate = wins / evaluated if evaluated else 0.0
    rug_rate = rugs / evaluated if evaluated else 0.0
    early_rate = early / calls
    roi_component = min(max(avg_roi, 0.0) / 10.0, 1.0)
    performance = (win_rate * 45.0 + roi_component * 20.0 - rug_rate * 35.0) * evaluation_confidence
    raw = experience * 10.0 + early_rate * 15.0 + performance
    return round(_clamp(raw), 2)


async def nearest_token_snapshot(
    session: AsyncSession,
    mint_address: str,
    at: datetime,
) -> tuple[float | None, float | None]:
    token = (
        await session.execute(select(Token).where(Token.mint_address == mint_address))
    ).scalar_one_or_none()
    if token is None:
        return None, None
    target = _aware(at)
    before = (
        await session.execute(
            select(TokenMetric)
            .where(
                TokenMetric.token_id == token.id,
                TokenMetric.timestamp <= at,
                TokenMetric.timestamp >= target - CALL_BASELINE_LOOKBACK,
            )
            .order_by(TokenMetric.timestamp.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if before is None:
        return None, None
    return before.price_usd, before.market_cap


async def upsert_channel_score(
    session: AsyncSession,
    channel_id: int,
) -> TelegramChannelScore:
    calls = list(
        (
            await session.execute(
                select(TelegramCall).where(
                    TelegramCall.channel_id == channel_id,
                    TelegramCall.is_explicit_call.is_(True),
                )
            )
        )
        .scalars()
        .all()
    )
    evaluated_rows = [call for call in calls if call.outcome != "pending"]
    wins = sum(1 for call in evaluated_rows if call.outcome in {"win", "win_then_rug"})
    rugs = sum(1 for call in evaluated_rows if call.outcome in {"rug", "win_then_rug"})
    early = sum(
        1
        for call in calls
        if call.call_market_cap_usd is not None and call.call_market_cap_usd <= 50_000
    )
    roi_values = [call.roi_multiple for call in evaluated_rows if call.roi_multiple is not None]
    avg_roi = mean(roi_values) if roi_values else 0.0
    score_value = score_channel_metrics(
        calls=len(calls),
        evaluated=len(evaluated_rows),
        wins=wins,
        rugs=rugs,
        early=early,
        avg_roi=avg_roi,
    )
    score = await session.get(TelegramChannelScore, channel_id)
    if score is None:
        score = TelegramChannelScore(channel_id=channel_id)
        session.add(score)
    score.calls_count = len(calls)
    score.evaluated_calls = len(evaluated_rows)
    score.successful_calls = wins
    score.rug_calls = rugs
    score.early_calls = early
    score.win_rate = wins / len(evaluated_rows) if evaluated_rows else 0.0
    score.rug_rate = rugs / len(evaluated_rows) if evaluated_rows else 0.0
    score.avg_roi = float(avg_roi)
    score.score = score_value
    score.updated_at = _utcnow()
    await session.flush()
    return score


def classify_call_outcome(
    *,
    roi_multiple: float | None,
    final_to_peak: float | None,
    observed_hours: float,
    maturity_hours: float = 72.0,
    rug_min_observation_hours: float = 6.0,
) -> str:
    """Classify only outcomes knowable at the current observation horizon.

    A >=2x win can be confirmed as soon as it occurs. A rug-like collapse can be
    confirmed after the minimum rug observation period. A loss is terminal only
    after the full configured maturity horizon, so a future 2x cannot be labeled
    as a loss merely because the token had not reached it after six hours.
    """
    rug_like = (
        observed_hours >= rug_min_observation_hours
        and final_to_peak is not None
        and 0 <= final_to_peak <= 0.20
    )
    won = roi_multiple is not None and roi_multiple >= 2.0
    if won and rug_like:
        return "win_then_rug"
    if rug_like:
        return "rug"
    if won:
        return "win"
    if roi_multiple is not None and observed_hours >= maturity_hours:
        return "loss"
    return "pending"


async def evaluate_calls(
    session: AsyncSession,
    *,
    limit: int = 1000,
    window_hours: int = 72,
) -> dict[str, int]:
    safe_window_hours = max(6, min(int(window_hours), 24 * 30))
    rows = list(
        (
            await session.execute(
                select(TelegramCall)
                .where(TelegramCall.is_explicit_call.is_(True))
                .order_by(TelegramCall.called_at.desc())
                .limit(max(1, min(limit, 5000)))
            )
        )
        .scalars()
        .all()
    )
    touched_channels: set[int] = set()
    processed = 0
    finalized = 0
    pending = 0
    for call in rows:
        token = (
            await session.execute(select(Token).where(Token.mint_address == call.mint_address))
        ).scalar_one_or_none()
        if token is None:
            continue

        if call.call_price_usd is None or call.call_market_cap_usd is None:
            causal_price, causal_market_cap = await nearest_token_snapshot(
                session,
                call.mint_address,
                call.called_at,
            )
            if call.call_price_usd is None:
                call.call_price_usd = causal_price
            if call.call_market_cap_usd is None:
                call.call_market_cap_usd = causal_market_cap

        window_end = _aware(call.called_at) + timedelta(hours=safe_window_hours)
        metrics = list(
            (
                await session.execute(
                    select(TokenMetric)
                    .where(
                        TokenMetric.token_id == token.id,
                        TokenMetric.timestamp >= call.called_at,
                        TokenMetric.timestamp <= window_end,
                    )
                    .order_by(TokenMetric.timestamp.asc())
                )
            )
            .scalars()
            .all()
        )
        if not metrics:
            continue

        prices = [
            metric.price_usd
            for metric in metrics
            if metric.price_usd is not None and metric.price_usd > 0
        ]
        caps = [
            metric.market_cap
            for metric in metrics
            if metric.market_cap is not None and metric.market_cap > 0
        ]
        call.peak_price_usd = max(prices) if prices else call.peak_price_usd
        call.peak_market_cap_usd = max(caps) if caps else call.peak_market_cap_usd

        roi = None
        if call.call_market_cap_usd and call.peak_market_cap_usd:
            roi = call.peak_market_cap_usd / call.call_market_cap_usd
        elif call.call_price_usd and call.peak_price_usd:
            roi = call.peak_price_usd / call.call_price_usd
        call.roi_multiple = roi

        observed_hours = max(
            (_aware(metrics[-1].timestamp) - _aware(call.called_at)).total_seconds() / 3600.0,
            0.0,
        )
        final_to_peak = None
        if caps and call.peak_market_cap_usd and call.peak_market_cap_usd > 0:
            final_to_peak = caps[-1] / call.peak_market_cap_usd
        elif prices and call.peak_price_usd and call.peak_price_usd > 0:
            final_to_peak = prices[-1] / call.peak_price_usd

        call.outcome = classify_call_outcome(
            roi_multiple=roi,
            final_to_peak=final_to_peak,
            observed_hours=observed_hours,
            maturity_hours=float(safe_window_hours),
        )
        call.meta = {
            **(call.meta or {}),
            "evaluation_window_hours": safe_window_hours,
            "observed_hours": round(observed_hours, 4),
            "final_to_peak": final_to_peak,
            "loss_requires_full_horizon": True,
            "causal_call_baseline": bool(
                call.call_price_usd is not None or call.call_market_cap_usd is not None
            ),
        }
        call.evaluated_at = _utcnow()
        touched_channels.add(call.channel_id)
        processed += 1
        if call.outcome == "pending":
            pending += 1
        else:
            finalized += 1

    for channel_id in touched_channels:
        await upsert_channel_score(session, channel_id)
    await session.commit()
    return {
        "evaluated": processed,
        "processed": processed,
        "finalized": finalized,
        "pending": pending,
        "channels_updated": len(touched_channels),
        "window_hours": safe_window_hours,
    }


async def list_channels(
    session: AsyncSession,
    *,
    limit: int = 100,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    total = int(
        (await session.execute(select(func.count()).select_from(TelegramChannel))).scalar_one()
    )
    rows = (
        await session.execute(
            select(TelegramChannel, TelegramChannelScore)
            .outerjoin(
                TelegramChannelScore,
                TelegramChannelScore.channel_id == TelegramChannel.id,
            )
            .order_by(
                func.coalesce(TelegramChannelScore.score, 0).desc(),
                TelegramChannel.participants.desc(),
            )
            .offset(offset)
            .limit(limit)
        )
    ).all()
    items = []
    for channel, score in rows:
        items.append(
            {
                "id": channel.id,
                "telegram_id": channel.telegram_id,
                "username": channel.username,
                "title": channel.title,
                "entity_type": channel.entity_type,
                "participants": channel.participants,
                "about": channel.about,
                "last_scanned_at": channel.last_scanned_at,
                "score": score.score if score else 0.0,
                "calls_count": score.calls_count if score else 0,
                "evaluated_calls": score.evaluated_calls if score else 0,
                "win_rate": score.win_rate if score else 0.0,
                "rug_rate": score.rug_rate if score else 0.0,
                "avg_roi": score.avg_roi if score else 0.0,
            }
        )
    return items, total


async def list_calls(
    session: AsyncSession,
    *,
    limit: int = 100,
    offset: int = 0,
    channel_id: int | None = None,
    mint_address: str | None = None,
) -> tuple[list[dict[str, Any]], int]:
    filters = []
    if channel_id is not None:
        filters.append(TelegramCall.channel_id == channel_id)
    if mint_address:
        filters.append(TelegramCall.mint_address == mint_address)
    count_stmt: Select = select(func.count()).select_from(TelegramCall)
    data_stmt = select(TelegramCall, TelegramChannel).join(
        TelegramChannel,
        TelegramChannel.id == TelegramCall.channel_id,
    )
    if filters:
        count_stmt = count_stmt.where(*filters)
        data_stmt = data_stmt.where(*filters)
    total = int((await session.execute(count_stmt)).scalar_one())
    rows = (
        await session.execute(
            data_stmt.order_by(TelegramCall.called_at.desc()).offset(offset).limit(limit)
        )
    ).all()
    return [
        {
            "id": call.id,
            "mint_address": call.mint_address,
            "channel_id": call.channel_id,
            "channel": channel.username or channel.title,
            "caller_username": call.caller_username,
            "called_at": call.called_at,
            "explicit_call": call.is_explicit_call,
            "call_market_cap_usd": call.call_market_cap_usd,
            "peak_market_cap_usd": call.peak_market_cap_usd,
            "roi_multiple": call.roi_multiple,
            "outcome": call.outcome,
        }
        for call, channel in rows
    ], total


def normalize_caller_username(value: str | None) -> str:
    return (value or "unknown").strip().lower().lstrip("@") or "unknown"


async def top_callers(
    session: AsyncSession,
    *,
    limit: int = 50,
) -> list[dict[str, Any]]:
    calls = list(
        (
            await session.execute(
                select(TelegramCall).where(
                    TelegramCall.caller_username.is_not(None),
                    TelegramCall.is_explicit_call.is_(True),
                )
            )
        )
        .scalars()
        .all()
    )
    grouped: dict[str, list[TelegramCall]] = defaultdict(list)
    for call in calls:
        grouped[normalize_caller_username(call.caller_username)].append(call)
    result = []
    for username, grouped_calls in grouped.items():
        evaluated = [row for row in grouped_calls if row.outcome != "pending"]
        wins = sum(1 for row in evaluated if row.outcome in {"win", "win_then_rug"})
        rugs = sum(1 for row in evaluated if row.outcome in {"rug", "win_then_rug"})
        rois = [row.roi_multiple for row in evaluated if row.roi_multiple is not None]
        avg_roi = mean(rois) if rois else 0.0
        early = sum(
            1
            for row in grouped_calls
            if row.call_market_cap_usd is not None and row.call_market_cap_usd <= 50_000
        )
        result.append(
            {
                "username": username,
                "calls": len(grouped_calls),
                "evaluated": len(evaluated),
                "wins": wins,
                "win_rate": wins / len(evaluated) if evaluated else 0.0,
                "rug_rate": rugs / len(evaluated) if evaluated else 0.0,
                "avg_roi": float(avg_roi),
                "score": score_channel_metrics(
                    calls=len(grouped_calls),
                    evaluated=len(evaluated),
                    wins=wins,
                    rugs=rugs,
                    early=early,
                    avg_roi=avg_roi,
                ),
            }
        )
    result.sort(key=lambda item: (item["score"], item["calls"]), reverse=True)
    return result[: max(1, min(limit, 250))]


async def token_timeline(
    session: AsyncSession,
    mint_address: str,
) -> dict[str, Any]:
    events = list(
        (
            await session.execute(
                select(SocialEvent)
                .where(SocialEvent.mint_address == mint_address)
                .order_by(SocialEvent.occurred_at.asc())
            )
        )
        .scalars()
        .all()
    )
    platforms: dict[str, int] = defaultdict(int)
    timeline = []
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


async def ingest_x_events(
    session: AsyncSession,
    payload: dict[str, Any],
) -> dict[str, int]:
    mint = str(payload.get("token_mint") or "").strip() or None
    symbol = str(payload.get("token_symbol") or "").strip() or None
    tweets = payload.get("tweets") or []
    inserted = 0
    updated = 0
    skipped_missing_timestamp = 0
    for tweet in tweets:
        external_id = str(tweet.get("id") or "").strip()
        if not external_id:
            continue
        posted_at_raw = tweet.get("posted_at")
        if isinstance(posted_at_raw, (int, float)):
            seconds = posted_at_raw / 1000 if posted_at_raw > 10_000_000_000 else posted_at_raw
            occurred_at = datetime.fromtimestamp(seconds, tz=UTC)
        else:
            skipped_missing_timestamp += 1
            continue
        existing = (
            await session.execute(
                select(SocialEvent).where(
                    SocialEvent.platform == "x",
                    SocialEvent.event_type == "token_mention",
                    SocialEvent.external_id == external_id,
                    SocialEvent.mint_address == mint,
                )
            )
        ).scalar_one_or_none()
        metrics = {
            "views": int(tweet.get("views") or 0),
            "likes": int(tweet.get("likes") or 0),
            "retweets": int(tweet.get("retweets") or 0),
            "replies": int(tweet.get("replies") or 0),
            "verified": bool(tweet.get("is_verified")),
            "suspicion_score": tweet.get("suspicion_score"),
            "suspicious": float(tweet.get("suspicion_score") or 0) >= 50.0,
        }
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
                    payload={"strategy": payload.get("strategy")},
                )
            )
            inserted += 1
        else:
            existing.source_handle = tweet.get("author_handle") or existing.source_handle
            existing.source_name = tweet.get("author_display_name") or existing.source_name
            existing.source_url = tweet.get("url") or existing.source_url
            existing.text = str(tweet.get("text") or existing.text)
            existing.occurred_at = occurred_at
            existing.metrics = metrics
            existing.payload = {"strategy": payload.get("strategy")}
            updated += 1
    await session.commit()
    return {
        "inserted": inserted,
        "updated": updated,
        "skipped_missing_timestamp": skipped_missing_timestamp,
    }


async def refresh_x_for_mint(
    *,
    backend_frontend_url: str,
    mint_address: str,
    symbol: str | None = None,
) -> dict[str, Any]:
    base = backend_frontend_url.rstrip("/")
    params = {"mint": mint_address, "scope": "mentions", "strategy": "auto"}
    if symbol:
        params["symbol"] = symbol
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(f"{base}/api/trade/dev-twitter", params=params)
        response.raise_for_status()
        data = response.json()
    tweets = []
    for item in data.get("topTweets") or []:
        tweets.append(
            {
                "id": str(item.get("id") or ""),
                "text": str(item.get("text") or ""),
                "author_handle": item.get("author"),
                "author_display_name": None,
                "url": item.get("url"),
                "views": int(item.get("views") or 0),
                "likes": int(item.get("likes") or 0),
                "retweets": int(item.get("retweets") or 0),
                "replies": int(item.get("replies") or 0),
                "is_verified": bool(item.get("isVerified")),
                "posted_at": item.get("timestamp"),
                "suspicion_score": 100 if item.get("isSuspicious") else 0,
            }
        )
    return {
        "token_mint": mint_address,
        "token_symbol": data.get("symbol") or symbol,
        "token_twitter_handle": data.get("twitterHandle"),
        "strategy": data.get("collectionStrategy"),
        "tweets": tweets,
    }


async def upsert_social_relation(
    session: AsyncSession,
    *,
    source_platform: str,
    source_handle: str,
    target_platform: str,
    target_handle: str,
    relation_type: str,
    evidence: str = "",
    occurred_at: datetime | None = None,
) -> SocialRelation:
    when = occurred_at or _utcnow()
    relation = (
        await session.execute(
            select(SocialRelation).where(
                SocialRelation.source_platform == source_platform,
                SocialRelation.source_handle == source_handle,
                SocialRelation.target_platform == target_platform,
                SocialRelation.target_handle == target_handle,
                SocialRelation.relation_type == relation_type,
            )
        )
    ).scalar_one_or_none()
    if relation is None:
        relation = SocialRelation(
            source_platform=source_platform,
            source_handle=source_handle,
            target_platform=target_platform,
            target_handle=target_handle,
            relation_type=relation_type,
            count=1,
            first_seen_at=when,
            last_seen_at=when,
            evidence=(evidence or "")[:1000],
        )
        session.add(relation)
    else:
        relation.count += 1
        relation.last_seen_at = when
        if evidence:
            relation.evidence = evidence[:1000]
    await session.flush()
    return relation


async def list_social_relations(
    session: AsyncSession,
    *,
    source_handle: str | None = None,
    platform: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    stmt = select(SocialRelation)
    filters = []
    if source_handle:
        filters.append(SocialRelation.source_handle == source_handle.lower().lstrip("@"))
    if platform:
        filters.append(SocialRelation.source_platform == platform.lower())
    if filters:
        stmt = stmt.where(*filters)
    rows = list(
        (
            await session.execute(
                stmt.order_by(
                    SocialRelation.count.desc(),
                    SocialRelation.last_seen_at.desc(),
                ).limit(max(1, min(limit, 1000)))
            )
        )
        .scalars()
        .all()
    )
    return [
        {
            "source_platform": row.source_platform,
            "source_handle": row.source_handle,
            "target_platform": row.target_platform,
            "target_handle": row.target_handle,
            "relation_type": row.relation_type,
            "count": row.count,
            "first_seen_at": row.first_seen_at,
            "last_seen_at": row.last_seen_at,
            "evidence": row.evidence,
        }
        for row in rows
    ]
