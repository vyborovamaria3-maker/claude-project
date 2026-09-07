from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.advanced_intelligence import IntelligenceCalibrationStat, IntelligenceOutcome
from app.models.analytics import Token, TokenMetric
from app.models.intelligence_memory import IntelligenceSnapshot
from app.services.entity_performance import refresh_entity_outcome_projection_for_mint
from app.services.outcome_evaluation_lock import acquire_outcome_write_lock

DEFAULT_HORIZONS = (6, 24, 72)
MAX_SNAPSHOTS_PER_RUN = 250
BASELINE_LOOKBACK = timedelta(minutes=90)
FINAL_COVERAGE_TOLERANCE = timedelta(hours=1)
OUTCOME_RETRY_INTERVAL = timedelta(hours=6)


def _snapshot_feature(snapshot: IntelligenceSnapshot, keys: tuple[str, ...]) -> float | None:
    payload = snapshot.payload or {}
    for row in payload.get("features") or []:
        if str(row.get("key") or "") not in keys:
            continue
        value = row.get("numericValue", row.get("value"))
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            continue
        if parsed == parsed:
            return parsed
    return None


def _calibration_bucket(probability: float) -> str:
    bounded = max(0.0, min(0.999999, probability))
    start = int(bounded * 10) / 10
    return f"{start:.1f}-{start + 0.1:.1f}"


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


async def _apply_calibration_delta(
    session: AsyncSession,
    *,
    snapshot: IntelligenceSnapshot,
    horizon_hours: int,
    old_confirmed: bool | None,
    new_confirmed: bool | None,
) -> bool:
    if old_confirmed is None and new_confirmed is None:
        return False

    alpha = _snapshot_feature(
        snapshot,
        ("scores.alpha", "combined.alpha", "social.alpha"),
    )
    if alpha is None:
        return False
    probability = max(0.0, min(1.0, alpha / 100.0))
    signal_type = f"alpha_2x_{horizon_hours}h"
    model_version = f"{snapshot.snapshot_version}:alpha-v1"
    bucket = _calibration_bucket(probability)
    row = (
        await session.execute(
            select(IntelligenceCalibrationStat).where(
                IntelligenceCalibrationStat.model_version == model_version,
                IntelligenceCalibrationStat.signal_type == signal_type,
                IntelligenceCalibrationStat.bucket == bucket,
            )
        )
    ).scalar_one_or_none()

    if row is None:
        if new_confirmed is None:
            return False
        row = IntelligenceCalibrationStat(
            model_version=model_version,
            signal_type=signal_type,
            bucket=bucket,
        )
        session.add(row)

    if old_confirmed == new_confirmed:
        return False

    if old_confirmed is None:
        row.sample_count += 1
        row.predicted_confidence_sum += probability
    elif new_confirmed is None:
        row.sample_count = max(0, row.sample_count - 1)
        row.predicted_confidence_sum = max(
            0.0,
            row.predicted_confidence_sum - probability,
        )

    if old_confirmed is True:
        row.confirmed_count = max(0, row.confirmed_count - 1)
    elif old_confirmed is False:
        row.contradicted_count = max(0, row.contradicted_count - 1)

    if new_confirmed is True:
        row.confirmed_count += 1
    elif new_confirmed is False:
        row.contradicted_count += 1

    row.updated_at = datetime.now(timezone.utc)
    return True


def _outcome_label(max_multiple: float | None, drawdown: float | None) -> str:
    collapsed = drawdown is not None and drawdown <= -80
    if max_multiple is None:
        return "unknown"
    if max_multiple >= 5 and collapsed:
        return "5x_then_collapse"
    if max_multiple >= 2 and collapsed:
        return "2x_then_collapse"
    if max_multiple >= 5:
        return "5x_plus"
    if max_multiple >= 2:
        return "2x_plus"
    if collapsed:
        return "collapse"
    return "sub_2x"


def _max_peak_to_trough_drawdown(rows: list[TokenMetric]) -> float | None:
    peak: float | None = None
    worst = 0.0
    seen = False
    for row in rows:
        if row.price_usd is None or row.price_usd <= 0:
            continue
        price = float(row.price_usd)
        seen = True
        if peak is None or price > peak:
            peak = price
            continue
        if peak > 0:
            drawdown = (price - peak) / peak * 100
            worst = min(worst, drawdown)
    return worst if seen else None


async def _record_unresolved_outcome(
    session: AsyncSession,
    *,
    snapshot: IntelligenceSnapshot,
    horizon_hours: int,
    status: str,
    payload: dict[str, Any] | None = None,
) -> None:
    """Record a retryable evaluation state without overwriting a completed result."""
    await acquire_outcome_write_lock(
        session,
        snapshot_id=snapshot.snapshot_id,
        horizon_hours=horizon_hours,
    )
    existing = (
        await session.execute(
            select(IntelligenceOutcome).where(
                IntelligenceOutcome.snapshot_id == snapshot.snapshot_id,
                IntelligenceOutcome.horizon_hours == horizon_hours,
            )
        )
    ).scalar_one_or_none()
    if existing is not None and existing.max_multiple is not None:
        return

    now = datetime.now(timezone.utc)
    state_payload = {
        **(payload or {}),
        "evaluation_status": status,
        "retry_after_seconds": int(OUTCOME_RETRY_INTERVAL.total_seconds()),
    }
    if existing is None:
        session.add(
            IntelligenceOutcome(
                snapshot_id=snapshot.snapshot_id,
                mint_address=snapshot.mint_address,
                horizon_hours=horizon_hours,
                outcome_label=status,
                payload=state_payload,
                evaluated_at=now,
            )
        )
    else:
        existing.outcome_label = status
        existing.payload = state_payload
        existing.evaluated_at = now


async def persist_outcome_values(
    session: AsyncSession,
    *,
    snapshot: IntelligenceSnapshot,
    horizon_hours: int,
    baseline_price_usd: float | None,
    max_price_usd: float | None,
    min_price_usd: float | None,
    final_price_usd: float | None,
    max_drawdown_pct: float | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    await acquire_outcome_write_lock(
        session,
        snapshot_id=snapshot.snapshot_id,
        horizon_hours=horizon_hours,
    )

    existing = (
        await session.execute(
            select(IntelligenceOutcome).where(
                IntelligenceOutcome.snapshot_id == snapshot.snapshot_id,
                IntelligenceOutcome.horizon_hours == horizon_hours,
            )
        )
    ).scalar_one_or_none()
    old_confirmed: bool | None = None
    if existing is not None and existing.max_multiple is not None:
        old_confirmed = existing.max_multiple >= 2

    baseline = baseline_price_usd
    max_multiple = (
        max_price_usd / baseline
        if baseline and baseline > 0 and max_price_usd is not None
        else None
    )
    new_confirmed = max_multiple >= 2 if max_multiple is not None else None
    baseline_floor_change = (
        (min_price_usd - baseline) / baseline * 100
        if baseline and baseline > 0 and min_price_usd is not None
        else None
    )
    drawdown = max_drawdown_pct
    drawdown_method = "peak_to_subsequent_trough"
    if drawdown is None:
        drawdown = baseline_floor_change
        drawdown_method = "baseline_floor_proxy"

    label = _outcome_label(max_multiple, drawdown)
    merged_payload = {
        **(payload or {}),
        "drawdown_method": drawdown_method,
        "baseline_to_min_pct": baseline_floor_change,
    }
    values = {
        "mint_address": snapshot.mint_address,
        "baseline_price_usd": baseline,
        "max_price_usd": max_price_usd,
        "min_price_usd": min_price_usd,
        "final_price_usd": final_price_usd,
        "max_multiple": max_multiple,
        "max_drawdown_pct": drawdown,
        "outcome_label": label,
        "payload": merged_payload,
        "evaluated_at": datetime.now(timezone.utc),
    }
    if existing is None:
        existing = IntelligenceOutcome(
            snapshot_id=snapshot.snapshot_id,
            horizon_hours=horizon_hours,
            **values,
        )
        session.add(existing)
    else:
        for key, value in values.items():
            setattr(existing, key, value)

    calibration_updated = await _apply_calibration_delta(
        session,
        snapshot=snapshot,
        horizon_hours=horizon_hours,
        old_confirmed=old_confirmed,
        new_confirmed=new_confirmed,
    )

    if horizon_hours == 72:
        await session.flush()
        await refresh_entity_outcome_projection_for_mint(
            session,
            mint_address=snapshot.mint_address,
            horizon_hours=72,
        )

    return {
        "snapshot_id": snapshot.snapshot_id,
        "horizon_hours": horizon_hours,
        "outcome_label": label,
        "max_multiple": max_multiple,
        "max_drawdown_pct": drawdown,
        "drawdown_method": drawdown_method,
        "calibration_updated": calibration_updated,
    }


async def _metrics_for_window(
    session: AsyncSession,
    *,
    mint: str,
    start: datetime,
    end: datetime,
) -> list[TokenMetric]:
    token_id = (
        await session.execute(select(Token.id).where(Token.mint_address == mint))
    ).scalar_one_or_none()
    if token_id is None:
        return []
    return list(
        (
            await session.execute(
                select(TokenMetric)
                .where(
                    TokenMetric.token_id == token_id,
                    TokenMetric.timestamp >= start,
                    TokenMetric.timestamp <= end,
                    TokenMetric.price_usd.is_not(None),
                )
                .order_by(TokenMetric.timestamp.asc())
            )
        ).scalars().all()
    )


def _select_causal_baseline(
    rows: list[TokenMetric],
    cutoff: datetime,
) -> TokenMetric | None:
    before = [
        row
        for row in rows
        if row.price_usd is not None
        and row.price_usd > 0
        and cutoff - BASELINE_LOOKBACK <= row.timestamp <= cutoff
    ]
    return before[-1] if before else None


async def _record_many_unresolved(
    session: AsyncSession,
    *,
    snapshot: IntelligenceSnapshot,
    horizons: Iterable[int],
    status: str,
    payload: dict[str, Any] | None = None,
) -> dict[int, dict[str, Any]]:
    results: dict[int, dict[str, Any]] = {}
    for horizon in horizons:
        await _record_unresolved_outcome(
            session,
            snapshot=snapshot,
            horizon_hours=horizon,
            status=status,
            payload=payload,
        )
        results[horizon] = {
            "status": status,
            "snapshot_id": snapshot.snapshot_id,
        }
    return results


async def _evaluate_snapshot_horizons(
    session: AsyncSession,
    *,
    snapshot: IntelligenceSnapshot,
    horizons: Iterable[int],
    now: datetime,
) -> dict[int, dict[str, Any]]:
    matured = sorted(
        {
            int(horizon)
            for horizon in horizons
            if int(horizon) > 0
            and now >= snapshot.created_at + timedelta(hours=int(horizon))
        }
    )
    if not matured:
        return {}

    cutoff = snapshot.created_at
    max_end = cutoff + timedelta(hours=max(matured))
    rows = await _metrics_for_window(
        session,
        mint=snapshot.mint_address,
        start=cutoff - BASELINE_LOOKBACK,
        end=max_end,
    )
    if not rows:
        return await _record_many_unresolved(
            session,
            snapshot=snapshot,
            horizons=matured,
            status="no_price_history",
        )

    baseline_row = _select_causal_baseline(rows, cutoff)
    if baseline_row is None:
        return await _record_many_unresolved(
            session,
            snapshot=snapshot,
            horizons=matured,
            status="no_causal_baseline",
        )

    results: dict[int, dict[str, Any]] = {}
    for horizon_hours in matured:
        end = cutoff + timedelta(hours=horizon_hours)
        outcome_rows = [
            row
            for row in rows
            if row.price_usd is not None
            and row.price_usd > 0
            and cutoff <= row.timestamp <= end
        ]
        if not outcome_rows:
            await _record_unresolved_outcome(
                session,
                snapshot=snapshot,
                horizon_hours=horizon_hours,
                status="no_valid_prices",
            )
            results[horizon_hours] = {
                "status": "no_valid_prices",
                "snapshot_id": snapshot.snapshot_id,
            }
            continue

        final_candidates = [
            row
            for row in outcome_rows
            if row.timestamp >= end - FINAL_COVERAGE_TOLERANCE
        ]
        if not final_candidates:
            latest_metric_at = outcome_rows[-1].timestamp.isoformat()
            await _record_unresolved_outcome(
                session,
                snapshot=snapshot,
                horizon_hours=horizon_hours,
                status="right_censored",
                payload={"latest_metric_at": latest_metric_at},
            )
            results[horizon_hours] = {
                "status": "right_censored",
                "snapshot_id": snapshot.snapshot_id,
                "latest_metric_at": latest_metric_at,
            }
            continue

        peak_to_trough = _max_peak_to_trough_drawdown(outcome_rows)
        result = await persist_outcome_values(
            session,
            snapshot=snapshot,
            horizon_hours=horizon_hours,
            baseline_price_usd=float(baseline_row.price_usd),
            max_price_usd=max(float(row.price_usd) for row in outcome_rows),
            min_price_usd=min(float(row.price_usd) for row in outcome_rows),
            final_price_usd=float(final_candidates[-1].price_usd),
            max_drawdown_pct=peak_to_trough,
            payload={
                "source": "token_metrics",
                "snapshot_created_at": cutoff.isoformat(),
                "horizon_end": end.isoformat(),
                "baseline_metric_at": baseline_row.timestamp.isoformat(),
                "final_metric_at": final_candidates[-1].timestamp.isoformat(),
                "samples": len(outcome_rows),
                "causal_baseline": True,
                "baseline_rule": "latest_metric_at_or_before_snapshot_within_90m",
                "strict_horizon_end": True,
                "right_censoring_checked": True,
                "peak_to_trough_drawdown": True,
                "shared_price_window_read": True,
            },
        )
        results[horizon_hours] = {"status": "evaluated", **result}
    return results


async def evaluate_snapshot_horizon(
    session: AsyncSession,
    *,
    snapshot: IntelligenceSnapshot,
    horizon_hours: int,
    now: datetime | None = None,
) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    end = snapshot.created_at + timedelta(hours=horizon_hours)
    if now < end:
        return {"status": "not_matured", "snapshot_id": snapshot.snapshot_id}
    results = await _evaluate_snapshot_horizons(
        session,
        snapshot=snapshot,
        horizons=(horizon_hours,),
        now=now,
    )
    return results.get(
        horizon_hours,
        {"status": "not_matured", "snapshot_id": snapshot.snapshot_id},
    )


def _missing_matured_outcome_condition(
    horizon_hours: int,
    now: datetime,
):
    matured_cutoff = now - timedelta(hours=horizon_hours)
    retry_cutoff = now - OUTCOME_RETRY_INTERVAL
    completed_exists = exists().where(
        IntelligenceOutcome.snapshot_id == IntelligenceSnapshot.snapshot_id,
        IntelligenceOutcome.horizon_hours == horizon_hours,
        IntelligenceOutcome.max_multiple.is_not(None),
    )
    recent_unresolved_exists = exists().where(
        IntelligenceOutcome.snapshot_id == IntelligenceSnapshot.snapshot_id,
        IntelligenceOutcome.horizon_hours == horizon_hours,
        IntelligenceOutcome.max_multiple.is_(None),
        IntelligenceOutcome.evaluated_at > retry_cutoff,
    )
    return and_(
        IntelligenceSnapshot.created_at <= matured_cutoff,
        ~completed_exists,
        ~recent_unresolved_exists,
    )


def _outcome_blocks_retry(row: IntelligenceOutcome, now: datetime) -> bool:
    if row.max_multiple is not None:
        return True
    return _utc(row.evaluated_at) > now - OUTCOME_RETRY_INTERVAL


async def evaluate_matured_outcomes(
    session: AsyncSession,
    *,
    horizons: Iterable[int] = DEFAULT_HORIZONS,
    now: datetime | None = None,
    limit: int = MAX_SNAPSHOTS_PER_RUN,
) -> dict[str, int]:
    now = now or datetime.now(timezone.utc)
    horizons = tuple(sorted({int(value) for value in horizons if int(value) > 0}))
    if not horizons:
        return {
            "snapshots": 0,
            "candidates_scanned": 0,
            "evaluated": 0,
            "censored": 0,
            "skipped": 0,
        }

    candidates = list(
        (
            await session.execute(
                select(IntelligenceSnapshot)
                .where(
                    or_(
                        *[
                            _missing_matured_outcome_condition(horizon, now)
                            for horizon in horizons
                        ]
                    )
                )
                .order_by(IntelligenceSnapshot.created_at.asc())
                .limit(limit)
            )
        ).scalars().all()
    )
    candidate_ids = [row.snapshot_id for row in candidates]
    existing_rows: list[IntelligenceOutcome] = []
    if candidate_ids:
        existing_rows = list(
            (
                await session.execute(
                    select(IntelligenceOutcome).where(
                        IntelligenceOutcome.snapshot_id.in_(candidate_ids),
                        IntelligenceOutcome.horizon_hours.in_(horizons),
                    )
                )
            ).scalars().all()
        )
    blocked = {
        (row.snapshot_id, row.horizon_hours)
        for row in existing_rows
        if _outcome_blocks_retry(row, now)
    }

    evaluated = 0
    censored = 0
    skipped = 0
    for snapshot in candidates:
        pending_horizons = [
            horizon
            for horizon in horizons
            if now >= snapshot.created_at + timedelta(hours=horizon)
            and (snapshot.snapshot_id, horizon) not in blocked
        ]
        if not pending_horizons:
            continue
        results = await _evaluate_snapshot_horizons(
            session,
            snapshot=snapshot,
            horizons=pending_horizons,
            now=now,
        )
        for horizon in pending_horizons:
            status = (results.get(horizon) or {}).get("status")
            if status == "evaluated":
                evaluated += 1
            elif status == "right_censored":
                censored += 1
            else:
                skipped += 1

    await session.commit()
    return {
        "snapshots": len(candidates),
        "candidates_scanned": len(candidates),
        "evaluated": evaluated,
        "censored": censored,
        "skipped": skipped,
    }
