from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.advanced_intelligence import IntelligenceCalibrationStat, IntelligenceOutcome
from app.models.analytics import Token, TokenMetric
from app.models.intelligence_memory import IntelligenceSnapshot

DEFAULT_HORIZONS = (6, 24, 72)
MAX_SNAPSHOTS_PER_RUN = 250


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


async def _apply_calibration_delta(
    session: AsyncSession,
    *,
    snapshot: IntelligenceSnapshot,
    horizon_hours: int,
    old_confirmed: bool | None,
    new_confirmed: bool,
) -> bool:
    alpha = _snapshot_feature(
        snapshot,
        ("combined.alpha", "social.alpha", "scores.alpha"),
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
        row = IntelligenceCalibrationStat(
            model_version=model_version,
            signal_type=signal_type,
            bucket=bucket,
        )
        session.add(row)

    if old_confirmed is None:
        row.sample_count += 1
        row.predicted_confidence_sum += probability
    elif old_confirmed == new_confirmed:
        return False
    else:
        if old_confirmed:
            row.confirmed_count = max(0, row.confirmed_count - 1)
        else:
            row.contradicted_count = max(0, row.contradicted_count - 1)

    if new_confirmed:
        row.confirmed_count += 1
    else:
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


async def persist_outcome_values(
    session: AsyncSession,
    *,
    snapshot: IntelligenceSnapshot,
    horizon_hours: int,
    baseline_price_usd: float | None,
    max_price_usd: float | None,
    min_price_usd: float | None,
    final_price_usd: float | None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    existing = (
        await session.execute(
            select(IntelligenceOutcome).where(
                IntelligenceOutcome.snapshot_id == snapshot.snapshot_id,
                IntelligenceOutcome.horizon_hours == horizon_hours,
            )
        )
    ).scalar_one_or_none()
    old_confirmed = None
    if existing is not None and existing.max_multiple is not None:
        old_confirmed = existing.max_multiple >= 2

    baseline = baseline_price_usd
    max_multiple = max_price_usd / baseline if baseline and max_price_usd is not None else None
    drawdown = (
        (min_price_usd - baseline) / baseline * 100
        if baseline and min_price_usd is not None
        else None
    )
    label = _outcome_label(max_multiple, drawdown)
    values = {
        "mint_address": snapshot.mint_address,
        "baseline_price_usd": baseline,
        "max_price_usd": max_price_usd,
        "min_price_usd": min_price_usd,
        "final_price_usd": final_price_usd,
        "max_multiple": max_multiple,
        "max_drawdown_pct": drawdown,
        "outcome_label": label,
        "payload": payload,
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

    calibration_updated = False
    if max_multiple is not None:
        calibration_updated = await _apply_calibration_delta(
            session,
            snapshot=snapshot,
            horizon_hours=horizon_hours,
            old_confirmed=old_confirmed,
            new_confirmed=max_multiple >= 2,
        )
    return {
        "snapshot_id": snapshot.snapshot_id,
        "horizon_hours": horizon_hours,
        "outcome_label": label,
        "max_multiple": max_multiple,
        "max_drawdown_pct": drawdown,
        "calibration_updated": calibration_updated,
    }


async def _metrics_for_window(
    session: AsyncSession,
    *,
    mint: str,
    start: datetime,
    end: datetime,
) -> list[TokenMetric]:
    token = (
        await session.execute(select(Token).where(Token.mint_address == mint))
    ).scalar_one_or_none()
    if token is None:
        return []
    return list(
        (
            await session.execute(
                select(TokenMetric)
                .where(
                    TokenMetric.token_id == token.id,
                    TokenMetric.timestamp >= start,
                    TokenMetric.timestamp <= end,
                    TokenMetric.price_usd.is_not(None),
                )
                .order_by(TokenMetric.timestamp.asc())
            )
        ).scalars().all()
    )


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

    # Use a small forward tolerance for the first price sample and require a metric
    # near the right edge, otherwise the sample is right-censored.
    rows = await _metrics_for_window(
        session,
        mint=snapshot.mint_address,
        start=snapshot.created_at,
        end=end + timedelta(minutes=15),
    )
    if not rows:
        return {"status": "no_price_history", "snapshot_id": snapshot.snapshot_id}
    baseline_row = next(
        (
            row
            for row in rows
            if row.price_usd is not None
            and row.timestamp <= snapshot.created_at + timedelta(hours=2)
        ),
        None,
    )
    if baseline_row is None or not baseline_row.price_usd or baseline_row.price_usd <= 0:
        return {"status": "no_baseline_price", "snapshot_id": snapshot.snapshot_id}
    covered = [row for row in rows if row.timestamp <= end + timedelta(minutes=15)]
    final_candidates = [
        row
        for row in covered
        if row.timestamp >= end - timedelta(hours=1) and row.price_usd is not None
    ]
    if not final_candidates:
        return {
            "status": "right_censored",
            "snapshot_id": snapshot.snapshot_id,
            "latest_metric_at": covered[-1].timestamp.isoformat() if covered else None,
        }
    priced = [row for row in covered if row.price_usd is not None and row.price_usd > 0]
    if not priced:
        return {"status": "no_valid_prices", "snapshot_id": snapshot.snapshot_id}

    result = await persist_outcome_values(
        session,
        snapshot=snapshot,
        horizon_hours=horizon_hours,
        baseline_price_usd=float(baseline_row.price_usd),
        max_price_usd=max(float(row.price_usd) for row in priced),
        min_price_usd=min(float(row.price_usd) for row in priced),
        final_price_usd=float(final_candidates[-1].price_usd),
        payload={
            "source": "token_metrics",
            "snapshot_created_at": snapshot.created_at.isoformat(),
            "horizon_end": end.isoformat(),
            "baseline_metric_at": baseline_row.timestamp.isoformat(),
            "final_metric_at": final_candidates[-1].timestamp.isoformat(),
            "samples": len(priced),
            "right_censoring_checked": True,
        },
    )
    return {"status": "evaluated", **result}


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
        return {"snapshots": 0, "evaluated": 0, "censored": 0, "skipped": 0}
    oldest_required = now - timedelta(hours=min(horizons))
    snapshots = list(
        (
            await session.execute(
                select(IntelligenceSnapshot)
                .where(IntelligenceSnapshot.created_at <= oldest_required)
                .order_by(IntelligenceSnapshot.created_at.asc())
                .limit(limit)
            )
        ).scalars().all()
    )
    existing_rows = []
    snapshot_ids = [row.snapshot_id for row in snapshots]
    if snapshot_ids:
        existing_rows = list(
            (
                await session.execute(
                    select(IntelligenceOutcome).where(
                        IntelligenceOutcome.snapshot_id.in_(snapshot_ids),
                        IntelligenceOutcome.horizon_hours.in_(horizons),
                    )
                )
            ).scalars().all()
        )
    existing = {(row.snapshot_id, row.horizon_hours) for row in existing_rows}

    evaluated = 0
    censored = 0
    skipped = 0
    for snapshot in snapshots:
        for horizon in horizons:
            if (snapshot.snapshot_id, horizon) in existing:
                continue
            if now < snapshot.created_at + timedelta(hours=horizon):
                continue
            result = await evaluate_snapshot_horizon(
                session,
                snapshot=snapshot,
                horizon_hours=horizon,
                now=now,
            )
            if result.get("status") == "evaluated":
                evaluated += 1
            elif result.get("status") == "right_censored":
                censored += 1
            else:
                skipped += 1
    await session.commit()
    return {
        "snapshots": len(snapshots),
        "evaluated": evaluated,
        "censored": censored,
        "skipped": skipped,
    }
