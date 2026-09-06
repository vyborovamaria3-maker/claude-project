from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analytics import Token, TokenMetric
from app.models.social_intelligence import TelegramCall, TelegramChannelScore
from app.services.social_intelligence import (
    CALL_BASELINE_LOOKBACK,
    classify_call_outcome,
    score_channel_metrics,
)

METRIC_TOKEN_CHUNK_SIZE = 200


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    return (
        value.replace(tzinfo=timezone.utc)
        if value.tzinfo is None
        else value.astimezone(timezone.utc)
    )


async def _load_metrics_for_calls(
    session: AsyncSession,
    calls_by_token: dict[int, list[TelegramCall]],
    *,
    window_hours: int,
) -> dict[int, list[TokenMetric]]:
    ranges: list[tuple[int, datetime, datetime]] = []
    for token_id, calls in calls_by_token.items():
        starts = [
            _aware(call.called_at)
            - (CALL_BASELINE_LOOKBACK if call.call_price_usd is None or call.call_market_cap_usd is None else timedelta())
            for call in calls
        ]
        ends = [_aware(call.called_at) + timedelta(hours=window_hours) for call in calls]
        ranges.append((token_id, min(starts), max(ends)))

    grouped: dict[int, list[TokenMetric]] = defaultdict(list)
    for start in range(0, len(ranges), METRIC_TOKEN_CHUNK_SIZE):
        chunk = ranges[start : start + METRIC_TOKEN_CHUNK_SIZE]
        conditions = [
            and_(
                TokenMetric.token_id == token_id,
                TokenMetric.timestamp >= range_start,
                TokenMetric.timestamp <= range_end,
            )
            for token_id, range_start, range_end in chunk
        ]
        if not conditions:
            continue
        rows = list(
            (
                await session.execute(
                    select(TokenMetric)
                    .where(or_(*conditions))
                    .order_by(TokenMetric.token_id.asc(), TokenMetric.timestamp.asc(), TokenMetric.id.asc())
                )
            ).scalars().all()
        )
        for metric in rows:
            grouped[metric.token_id].append(metric)
    return grouped


def _baseline_from_rows(
    rows: list[TokenMetric],
    called_at: datetime,
) -> TokenMetric | None:
    target = _aware(called_at)
    lower = target - CALL_BASELINE_LOOKBACK
    candidate = None
    for metric in rows:
        timestamp = _aware(metric.timestamp)
        if timestamp < lower:
            continue
        if timestamp > target:
            break
        candidate = metric
    return candidate


def _window_rows(
    rows: list[TokenMetric],
    called_at: datetime,
    window_hours: int,
) -> list[TokenMetric]:
    start = _aware(called_at)
    end = start + timedelta(hours=window_hours)
    return [
        metric
        for metric in rows
        if start <= _aware(metric.timestamp) <= end
    ]


async def _refresh_channel_scores(
    session: AsyncSession,
    channel_ids: set[int],
) -> None:
    if not channel_ids:
        return

    evaluated = case((TelegramCall.outcome != "pending", 1), else_=0)
    wins = case((TelegramCall.outcome.in_({"win", "win_then_rug"}), 1), else_=0)
    rugs = case((TelegramCall.outcome.in_({"rug", "win_then_rug"}), 1), else_=0)
    early = case((TelegramCall.call_market_cap_usd <= 50_000, 1), else_=0)
    evaluated_roi = case(
        (
            and_(
                TelegramCall.outcome != "pending",
                TelegramCall.roi_multiple.is_not(None),
            ),
            TelegramCall.roi_multiple,
        ),
        else_=None,
    )

    aggregate_rows = (
        await session.execute(
            select(
                TelegramCall.channel_id,
                func.count(TelegramCall.id).label("calls"),
                func.sum(evaluated).label("evaluated"),
                func.sum(wins).label("wins"),
                func.sum(rugs).label("rugs"),
                func.sum(early).label("early"),
                func.avg(evaluated_roi).label("avg_roi"),
            )
            .where(
                TelegramCall.channel_id.in_(channel_ids),
                TelegramCall.is_explicit_call.is_(True),
            )
            .group_by(TelegramCall.channel_id)
        )
    ).all()

    existing_rows = list(
        (
            await session.execute(
                select(TelegramChannelScore).where(
                    TelegramChannelScore.channel_id.in_(channel_ids)
                )
            )
        ).scalars().all()
    )
    existing = {row.channel_id: row for row in existing_rows}

    for aggregate in aggregate_rows:
        calls = int(aggregate.calls or 0)
        evaluated_count = int(aggregate.evaluated or 0)
        win_count = int(aggregate.wins or 0)
        rug_count = int(aggregate.rugs or 0)
        early_count = int(aggregate.early or 0)
        avg_roi = float(aggregate.avg_roi or 0.0)
        score_value = score_channel_metrics(
            calls=calls,
            evaluated=evaluated_count,
            wins=win_count,
            rugs=rug_count,
            early=early_count,
            avg_roi=avg_roi,
        )

        score = existing.get(int(aggregate.channel_id))
        if score is None:
            score = TelegramChannelScore(channel_id=int(aggregate.channel_id))
            session.add(score)
        score.calls_count = calls
        score.evaluated_calls = evaluated_count
        score.successful_calls = win_count
        score.rug_calls = rug_count
        score.early_calls = early_count
        score.win_rate = win_count / evaluated_count if evaluated_count else 0.0
        score.rug_rate = rug_count / evaluated_count if evaluated_count else 0.0
        score.avg_roi = avg_roi
        score.score = score_value
        score.updated_at = _utcnow()


async def evaluate_calls(
    session: AsyncSession,
    *,
    limit: int = 1000,
    window_hours: int = 72,
) -> dict[str, int]:
    """Evaluate Telegram calls with bulk token/metric reads instead of per-call N+1 queries."""
    safe_window_hours = max(6, min(int(window_hours), 24 * 30))
    calls = list(
        (
            await session.execute(
                select(TelegramCall)
                .where(TelegramCall.is_explicit_call.is_(True))
                .order_by(TelegramCall.called_at.desc())
                .limit(max(1, min(limit, 5000)))
            )
        ).scalars().all()
    )
    if not calls:
        return {
            "evaluated": 0,
            "processed": 0,
            "finalized": 0,
            "pending": 0,
            "channels_updated": 0,
            "window_hours": safe_window_hours,
        }

    mint_addresses = {call.mint_address for call in calls}
    token_rows = (
        await session.execute(
            select(Token.id, Token.mint_address).where(Token.mint_address.in_(mint_addresses))
        )
    ).all()
    token_by_mint = {mint: int(token_id) for token_id, mint in token_rows}

    calls_by_token: dict[int, list[TelegramCall]] = defaultdict(list)
    for call in calls:
        token_id = token_by_mint.get(call.mint_address)
        if token_id is not None:
            calls_by_token[token_id].append(call)

    metrics_by_token = await _load_metrics_for_calls(
        session,
        calls_by_token,
        window_hours=safe_window_hours,
    )

    touched_channels: set[int] = set()
    processed = 0
    finalized = 0
    pending = 0

    for token_id, token_calls in calls_by_token.items():
        token_metrics = metrics_by_token.get(token_id, [])
        if not token_metrics:
            continue
        for call in token_calls:
            if call.call_price_usd is None or call.call_market_cap_usd is None:
                baseline = _baseline_from_rows(token_metrics, call.called_at)
                if baseline is not None:
                    if call.call_price_usd is None:
                        call.call_price_usd = baseline.price_usd
                    if call.call_market_cap_usd is None:
                        call.call_market_cap_usd = baseline.market_cap

            metrics = _window_rows(token_metrics, call.called_at, safe_window_hours)
            if not metrics:
                continue

            prices = [
                float(metric.price_usd)
                for metric in metrics
                if metric.price_usd is not None and metric.price_usd > 0
            ]
            caps = [
                float(metric.market_cap)
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
                (
                    _aware(metrics[-1].timestamp) - _aware(call.called_at)
                ).total_seconds()
                / 3600.0,
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
                    call.call_price_usd is not None
                    or call.call_market_cap_usd is not None
                ),
                "bulk_evaluation": True,
            }
            call.evaluated_at = _utcnow()
            touched_channels.add(call.channel_id)
            processed += 1
            if call.outcome == "pending":
                pending += 1
            else:
                finalized += 1

    # Make the updated outcomes visible to the aggregate score query in one flush.
    await session.flush()
    await _refresh_channel_scores(session, touched_channels)
    await session.commit()
    return {
        "evaluated": processed,
        "processed": processed,
        "finalized": finalized,
        "pending": pending,
        "channels_updated": len(touched_channels),
        "window_hours": safe_window_hours,
    }
