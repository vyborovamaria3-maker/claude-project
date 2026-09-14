from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analytics import Token, TokenMetric, Wallet, WalletTrade
from app.models.kol_intelligence import KOLProfile, KOLWalletAttribution


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _safe_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if parsed != parsed or parsed in {float("inf"), float("-inf")}:
        return None
    return parsed


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _attribution_rank(
    attribution: KOLWalletAttribution,
    profile: KOLProfile,
) -> tuple[int, float, float, int]:
    return (
        1 if attribution.verified else 0,
        float(attribution.confidence or 0.0),
        float(profile.confidence or 0.0),
        -int(profile.id or 0),
    )


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * percentile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def _round(value: float | None, digits: int = 3) -> float | None:
    return round(value, digits) if value is not None else None


def _price_at_or_before(
    points: list[tuple[datetime, float]],
    timestamps: list[datetime],
    target: datetime,
    *,
    max_age: timedelta,
) -> tuple[float, datetime] | None:
    target = _aware(target)
    index = bisect_right(timestamps, target) - 1
    if index < 0:
        return None
    timestamp, price = points[index]
    if target - timestamp > max_age:
        return None
    return price, timestamp


def _price_at_or_after(
    points: list[tuple[datetime, float]],
    timestamps: list[datetime],
    target: datetime,
    *,
    max_lag: timedelta,
) -> tuple[float, datetime] | None:
    target = _aware(target)
    index = bisect_left(timestamps, target)
    if index >= len(points):
        return None
    timestamp, price = points[index]
    if timestamp - target > max_lag:
        return None
    return price, timestamp


def _summary(values: list[float]) -> dict[str, Any]:
    if not values:
        return {
            "samples": 0,
            "winRate": None,
            "avgDirectionalReturnPct": None,
            "medianDirectionalReturnPct": None,
            "p25DirectionalReturnPct": None,
            "p75DirectionalReturnPct": None,
            "bestDirectionalReturnPct": None,
            "worstDirectionalReturnPct": None,
        }
    wins = sum(1 for value in values if value > 0)
    return {
        "samples": len(values),
        "winRate": round(wins / len(values) * 100, 2),
        "avgDirectionalReturnPct": round(sum(values) / len(values), 3),
        "medianDirectionalReturnPct": round(median(values), 3),
        "p25DirectionalReturnPct": _round(_percentile(values, 0.25)),
        "p75DirectionalReturnPct": _round(_percentile(values, 0.75)),
        "bestDirectionalReturnPct": round(max(values), 3),
        "worstDirectionalReturnPct": round(min(values), 3),
    }


async def backtest_kol_signals(
    session: AsyncSession,
    *,
    lookback_days: int = 90,
    min_kols: int = 3,
    min_confidence: float = 70.0,
    window_minutes: int = 60,
    cooldown_minutes: int = 60,
    cost_bps: int = 50,
    horizons_hours: tuple[int, ...] = (1, 6, 24),
    max_signals: int = 500,
    strict_attribution_time: bool = False,
) -> dict[str, Any]:
    """Backtest KOL accumulation/distribution signals against historical prices.

    Signal construction uses only trade timestamps available at or before the trigger.
    The entry price must be an independently timestamped TokenMetric at or before the
    trigger; future TokenMetric rows are consulted only for outcome measurement.
    Current KOL labels can still introduce attribution-selection bias unless strict
    attribution timing is enabled.
    """

    now = utcnow()
    cutoff = now - timedelta(days=lookback_days)
    window = timedelta(minutes=window_minutes)
    cooldown = timedelta(minutes=cooldown_minutes)

    raw_rows = list(
        (
            await session.execute(
                select(WalletTrade, Token, Wallet, KOLWalletAttribution, KOLProfile)
                .join(Token, Token.id == WalletTrade.token_id)
                .join(Wallet, Wallet.id == WalletTrade.wallet_id)
                .join(
                    KOLWalletAttribution,
                    KOLWalletAttribution.analytics_wallet_id == Wallet.id,
                )
                .join(KOLProfile, KOLProfile.id == KOLWalletAttribution.kol_id)
                .where(
                    KOLWalletAttribution.chain == "solana",
                    KOLWalletAttribution.confidence >= min_confidence,
                    or_(
                        WalletTrade.buy_timestamp >= cutoff,
                        WalletTrade.sell_timestamp >= cutoff,
                    ),
                )
            )
        ).all()
    )

    # A single wallet can have several labels. Keep one strongest identity per
    # WalletTrade so neither actor counts nor returns are duplicated by the join.
    best_by_trade: dict[int, tuple[WalletTrade, Token, Wallet, KOLWalletAttribution, KOLProfile]] = {}
    for row in raw_rows:
        trade, _token, _wallet, attribution, profile = row
        existing = best_by_trade.get(trade.id)
        if existing is None or _attribution_rank(attribution, profile) > _attribution_rank(
            existing[3], existing[4]
        ):
            best_by_trade[trade.id] = row

    events_by_token_side: dict[tuple[int, str], list[dict[str, Any]]] = defaultdict(list)
    tokens: dict[int, Token] = {}
    for trade, token, wallet, attribution, profile in best_by_trade.values():
        tokens[token.id] = token
        first_seen_at = _aware(attribution.first_seen_at)
        if trade.buy_timestamp:
            buy_timestamp = _aware(trade.buy_timestamp)
            if buy_timestamp >= cutoff and (
                not strict_attribution_time or buy_timestamp >= first_seen_at
            ):
                events_by_token_side[(token.id, "accumulation")].append(
                    {
                        "timestamp": buy_timestamp,
                        "handle": profile.twitter_handle,
                        "wallet": wallet.wallet_address,
                        "tradeId": trade.id,
                        "confidence": float(attribution.confidence or 0.0),
                    }
                )
        if trade.sell_timestamp:
            sell_timestamp = _aware(trade.sell_timestamp)
            if sell_timestamp >= cutoff and (
                not strict_attribution_time or sell_timestamp >= first_seen_at
            ):
                events_by_token_side[(token.id, "distribution")].append(
                    {
                        "timestamp": sell_timestamp,
                        "handle": profile.twitter_handle,
                        "wallet": wallet.wallet_address,
                        "tradeId": trade.id,
                        "confidence": float(attribution.confidence or 0.0),
                    }
                )

    candidate_token_ids = list(tokens)
    metric_rows: list[tuple[int, datetime, float | None]] = []
    if candidate_token_ids:
        metric_rows = list(
            (
                await session.execute(
                    select(TokenMetric.token_id, TokenMetric.timestamp, TokenMetric.price_usd)
                    .where(
                        TokenMetric.token_id.in_(candidate_token_ids),
                        TokenMetric.timestamp >= cutoff - timedelta(hours=3),
                        TokenMetric.price_usd.is_not(None),
                    )
                    .order_by(TokenMetric.token_id.asc(), TokenMetric.timestamp.asc())
                )
            ).all()
        )

    price_points: dict[int, list[tuple[datetime, float]]] = defaultdict(list)
    for token_id, timestamp, raw_price in metric_rows:
        price = _safe_float(raw_price)
        if price is not None and price > 0:
            price_points[token_id].append((_aware(timestamp), price))
    price_timestamps = {
        token_id: [timestamp for timestamp, _price in points]
        for token_id, points in price_points.items()
    }

    all_signals: list[dict[str, Any]] = []
    raw_signal_triggers = 0
    skipped_no_baseline = 0
    for (token_id, signal_type), raw_events in events_by_token_side.items():
        events = sorted(raw_events, key=lambda item: item["timestamp"])
        active: deque[dict[str, Any]] = deque()
        last_signal_at: datetime | None = None

        for event in events:
            timestamp = event["timestamp"]
            while active and timestamp - active[0]["timestamp"] > window:
                active.popleft()
            active.append(event)

            # A handle can trade multiple times/wallets inside the window. Count
            # that identity once and retain its most recent event.
            by_handle: dict[str, dict[str, Any]] = {}
            for active_event in active:
                by_handle[active_event["handle"]] = active_event
            if len(by_handle) < min_kols:
                continue
            if last_signal_at is not None and timestamp - last_signal_at < cooldown:
                continue

            raw_signal_triggers += 1
            participants = sorted(by_handle.values(), key=lambda item: item["handle"])
            points = price_points.get(token_id, [])
            timestamps = price_timestamps.get(token_id, [])
            resolved_baseline = _price_at_or_before(
                points,
                timestamps,
                timestamp,
                max_age=timedelta(hours=2),
            )
            if resolved_baseline is None:
                # Preserve the actual trigger/cooldown timeline instead of waiting
                # for a later price point, which would introduce observability bias.
                skipped_no_baseline += 1
                last_signal_at = timestamp
                continue

            baseline_price, baseline_timestamp = resolved_baseline
            baseline_source = "token_metric_before_signal"

            returns: dict[str, Any] = {}
            for horizon in horizons_hours:
                target = timestamp + timedelta(hours=horizon)
                tolerance = timedelta(
                    minutes=90 if horizon == 1 else 180 if horizon <= 6 else 360
                )
                future = _price_at_or_after(
                    points,
                    timestamps,
                    target,
                    max_lag=tolerance,
                )
                if future is None:
                    returns[f"{horizon}h"] = None
                    continue
                future_price, future_timestamp = future
                raw_return = (future_price / baseline_price - 1) * 100
                directional = raw_return if signal_type == "accumulation" else -raw_return
                net_directional = directional - (cost_bps / 100)
                returns[f"{horizon}h"] = {
                    "futurePriceUsd": round(future_price, 12),
                    "priceTimestamp": future_timestamp.isoformat(),
                    "rawReturnPct": round(raw_return, 3),
                    "directionalReturnPct": round(directional, 3),
                    "netDirectionalReturnPct": round(net_directional, 3),
                    "win": net_directional > 0,
                }

            token = tokens[token_id]
            all_signals.append(
                {
                    "signalType": signal_type,
                    "mint": token.mint_address,
                    "symbol": token.symbol,
                    "tokenName": token.name,
                    "signalAt": timestamp.isoformat(),
                    "windowMinutes": window_minutes,
                    "kolCount": len(participants),
                    "handles": [item["handle"] for item in participants],
                    "wallets": sorted({item["wallet"] for item in participants}),
                    "tradeIds": sorted({int(item["tradeId"]) for item in participants}),
                    "minParticipantConfidence": round(
                        min(item["confidence"] for item in participants), 2
                    ),
                    "baselinePriceUsd": round(float(baseline_price), 12),
                    "baselinePriceAt": baseline_timestamp.isoformat(),
                    "baselineSource": baseline_source,
                    "returns": returns,
                }
            )
            last_signal_at = timestamp

    all_signals.sort(key=lambda item: item["signalAt"], reverse=True)

    by_horizon: dict[str, dict[str, Any]] = {}
    by_side: dict[str, dict[str, Any]] = {}
    for horizon in horizons_hours:
        key = f"{horizon}h"
        values = [
            float(signal["returns"][key]["netDirectionalReturnPct"])
            for signal in all_signals
            if signal["returns"].get(key) is not None
        ]
        by_horizon[key] = _summary(values)

    for side in ("accumulation", "distribution"):
        side_signals = [signal for signal in all_signals if signal["signalType"] == side]
        side_horizons: dict[str, Any] = {}
        for horizon in horizons_hours:
            key = f"{horizon}h"
            values = [
                float(signal["returns"][key]["netDirectionalReturnPct"])
                for signal in side_signals
                if signal["returns"].get(key) is not None
            ]
            side_horizons[key] = _summary(values)
        by_side[side] = {
            "signals": len(side_signals),
            "horizons": side_horizons,
        }

    returned_signals = all_signals[:max_signals]
    return {
        "status": "ok",
        "generatedAt": now.isoformat(),
        "period": {
            "lookbackDays": lookback_days,
            "from": cutoff.isoformat(),
            "to": now.isoformat(),
        },
        "parameters": {
            "minKols": min_kols,
            "minConfidence": min_confidence,
            "windowMinutes": window_minutes,
            "cooldownMinutes": cooldown_minutes,
            "costBps": cost_bps,
            "horizonsHours": list(horizons_hours),
            "strictAttributionTime": strict_attribution_time,
        },
        "coverage": {
            "joinedTradeRows": len(raw_rows),
            "uniqueTrades": len(best_by_trade),
            "tokensWithAttributedTrades": len(tokens),
            "tokensWithPriceHistory": len(price_points),
            "rawSignalTriggers": raw_signal_triggers,
            "signalsSkippedNoBaseline": skipped_no_baseline,
            "signals": len(all_signals),
            "returnedSignals": len(returned_signals),
            "signalsWith24hOutcome": sum(
                1 for signal in all_signals if signal["returns"].get("24h") is not None
            ),
        },
        "summary": {
            "byHorizon": by_horizon,
            "bySignalType": by_side,
        },
        "methodology": {
            "entryPrice": "latest TokenMetric at or before the signal (max age 2h); signals without a pre-signal price are excluded from evaluated outcomes",
            "outcomes": "first TokenMetric at or after each target horizon within a bounded lag tolerance",
            "eventGranularity": "WalletTrade position-level buy/sell timestamps; repeated intra-position fills may be compressed upstream",
            "dedupe": "one strongest KOL attribution per WalletTrade; one identity per rolling signal window",
            "transactionCost": f"{cost_bps} bps subtracted from directional return",
            "lookaheadGuard": "future prices and position-average trade prices are never used for signal construction or entry selection",
            "attributionBias": (
                "strict: trades before attribution.first_seen_at are excluded"
                if strict_attribution_time
                else "current KOL attribution snapshot is applied to historical trades; this can introduce selection/look-ahead bias"
            ),
        },
        "signals": returned_signals,
    }
