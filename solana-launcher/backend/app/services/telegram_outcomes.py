from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analytics import Token, TokenMetric
from app.models.social_intelligence import TelegramCall
from app.services.social_intelligence import nearest_token_snapshot


OUTCOME_WINDOWS_MINUTES: tuple[tuple[str, int], ...] = (
    ("5m", 5),
    ("15m", 15),
    ("1h", 60),
    ("4h", 240),
    ("24h", 1440),
)
OUTCOME_WINDOWS_VERSION = 1


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _positive(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _metric_timestamp(metric: Any) -> datetime:
    value = getattr(metric, "timestamp", None)
    if not isinstance(value, datetime):
        raise TypeError("metric.timestamp must be datetime")
    return _aware(value)


def _metric_price(metric: Any) -> float | None:
    return _positive(getattr(metric, "price_usd", None))


def _metric_cap(metric: Any) -> float | None:
    return _positive(getattr(metric, "market_cap", None))


def _multiple(value: float | None, baseline: float | None) -> float | None:
    if value is None or baseline is None or baseline <= 0:
        return None
    return value / baseline


def _round(value: float | None, digits: int = 6) -> float | None:
    return round(value, digits) if value is not None else None


def build_outcome_windows(
    metrics: Iterable[Any],
    *,
    called_at: datetime,
    call_price_usd: float | None,
    call_market_cap_usd: float | None,
) -> dict[str, dict[str, Any]]:
    """Build causal forward outcome windows from metrics observed after one call.

    Each window uses only metrics at or before the horizon target. `complete` is true only
    when the metric series itself reaches that horizon, so missing history never becomes 0x.
    Market cap is the preferred baseline/value when both call and metric market cap exist;
    otherwise price is used.
    """

    start = _aware(called_at)
    rows = sorted(
        [metric for metric in metrics if _metric_timestamp(metric) >= start],
        key=_metric_timestamp,
    )
    latest_available = _metric_timestamp(rows[-1]) if rows else None
    baseline_cap = _positive(call_market_cap_usd)
    baseline_price = _positive(call_price_usd)
    result: dict[str, dict[str, Any]] = {}

    for label, minutes in OUTCOME_WINDOWS_MINUTES:
        target = start + timedelta(minutes=minutes)
        eligible = [metric for metric in rows if _metric_timestamp(metric) <= target]
        complete = latest_available is not None and latest_available >= target
        if not eligible:
            result[label] = {
                "minutes": minutes,
                "target_at": target.isoformat(),
                "complete": False,
                "samples": 0,
                "observed_at": None,
                "baseline_kind": "market_cap" if baseline_cap is not None else "price" if baseline_price is not None else None,
                "close_multiple": None,
                "peak_multiple": None,
                "return_pct": None,
                "final_to_peak": None,
                "drawdown_from_peak_pct": None,
            }
            continue

        close = eligible[-1]
        close_cap = _metric_cap(close)
        close_price = _metric_price(close)
        caps = [value for value in (_metric_cap(metric) for metric in eligible) if value is not None]
        prices = [value for value in (_metric_price(metric) for metric in eligible) if value is not None]

        if baseline_cap is not None and (close_cap is not None or caps):
            baseline_kind = "market_cap"
            close_value = close_cap
            peak_value = max(caps) if caps else None
            baseline_value = baseline_cap
        else:
            baseline_kind = "price" if baseline_price is not None else None
            close_value = close_price
            peak_value = max(prices) if prices else None
            baseline_value = baseline_price

        close_multiple = _multiple(close_value, baseline_value)
        peak_multiple = _multiple(peak_value, baseline_value)
        final_to_peak = (
            close_value / peak_value
            if close_value is not None and peak_value is not None and peak_value > 0
            else None
        )
        result[label] = {
            "minutes": minutes,
            "target_at": target.isoformat(),
            "complete": bool(complete),
            "samples": len(eligible),
            "observed_at": _metric_timestamp(close).isoformat(),
            "baseline_kind": baseline_kind,
            "close_price_usd": _round(close_price),
            "close_market_cap_usd": _round(close_cap),
            "close_multiple": _round(close_multiple),
            "peak_multiple": _round(peak_multiple),
            "return_pct": _round((close_multiple - 1) * 100 if close_multiple is not None else None, 3),
            "final_to_peak": _round(final_to_peak),
            "drawdown_from_peak_pct": _round((1 - final_to_peak) * 100 if final_to_peak is not None else None, 3),
        }

    return result


async def evaluate_outcome_windows(
    session: AsyncSession,
    *,
    limit: int = 5000,
    commit: bool = True,
) -> dict[str, Any]:
    rows = list(
        (
            await session.execute(
                select(TelegramCall)
                .where(TelegramCall.is_explicit_call.is_(True))
                .order_by(TelegramCall.called_at.desc())
                .limit(max(1, min(int(limit), 20_000)))
            )
        ).scalars().all()
    )
    processed = 0
    skipped_no_token = 0
    skipped_no_metrics = 0
    complete_counts = {label: 0 for label, _ in OUTCOME_WINDOWS_MINUTES}

    for call in rows:
        token = (
            await session.execute(
                select(Token).where(Token.mint_address == call.mint_address)
            )
        ).scalar_one_or_none()
        if token is None:
            skipped_no_token += 1
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

        end = _aware(call.called_at) + timedelta(hours=24)
        metrics = list(
            (
                await session.execute(
                    select(TokenMetric)
                    .where(
                        TokenMetric.token_id == token.id,
                        TokenMetric.timestamp >= call.called_at,
                        TokenMetric.timestamp <= end,
                    )
                    .order_by(TokenMetric.timestamp.asc())
                )
            ).scalars().all()
        )
        if not metrics:
            skipped_no_metrics += 1
            continue

        windows = build_outcome_windows(
            metrics,
            called_at=call.called_at,
            call_price_usd=call.call_price_usd,
            call_market_cap_usd=call.call_market_cap_usd,
        )
        for label, _ in OUTCOME_WINDOWS_MINUTES:
            if windows[label].get("complete"):
                complete_counts[label] += 1
        call.meta = {
            **(call.meta or {}),
            "outcome_windows_version": OUTCOME_WINDOWS_VERSION,
            "outcome_windows_updated_at": _utcnow().isoformat(),
            "outcome_windows": windows,
        }
        processed += 1

    await session.flush()
    if commit:
        await session.commit()
    return {
        "processed": processed,
        "requested": len(rows),
        "skipped_no_token": skipped_no_token,
        "skipped_no_metrics": skipped_no_metrics,
        "complete": complete_counts,
        "windows": [label for label, _ in OUTCOME_WINDOWS_MINUTES],
        "version": OUTCOME_WINDOWS_VERSION,
    }
