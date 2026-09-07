from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from app.models.intelligence_memory import IntelligenceSnapshot
from app.services import intelligence_outcomes


@dataclass
class PriceRow:
    timestamp: datetime
    price_usd: float


async def test_multi_horizon_outcome_evaluation_reads_price_history_once(monkeypatch) -> None:
    cutoff = datetime.now(timezone.utc) - timedelta(days=5)
    snapshot = IntelligenceSnapshot(
        snapshot_id="snapshot-shared-window",
        mint_address="mint-shared-window",
        snapshot_version="snapshot-v1",
        graph_version="graph-v1",
        feature_count=0,
        missing_feature_count=0,
        payload={"features": []},
        created_at=cutoff,
    )
    rows = [
        PriceRow(cutoff - timedelta(minutes=10), 1.0),
        PriceRow(cutoff, 1.0),
        PriceRow(cutoff + timedelta(hours=6), 2.0),
        PriceRow(cutoff + timedelta(hours=24), 3.0),
        PriceRow(cutoff + timedelta(hours=72), 4.0),
    ]
    metric_reads = 0
    persisted: list[tuple[int, float | None]] = []

    async def fake_metrics_for_window(session, *, mint, start, end):
        nonlocal metric_reads
        del session, mint
        metric_reads += 1
        assert start == cutoff - intelligence_outcomes.BASELINE_LOOKBACK
        assert end == cutoff + timedelta(hours=72)
        return rows

    async def fake_persist(session, *, horizon_hours, max_price_usd, **kwargs):
        del session, kwargs
        persisted.append((horizon_hours, max_price_usd))
        return {
            "snapshot_id": snapshot.snapshot_id,
            "horizon_hours": horizon_hours,
            "outcome_label": "test",
            "max_multiple": max_price_usd,
            "max_drawdown_pct": 0.0,
            "drawdown_method": "test",
            "calibration_updated": False,
        }

    monkeypatch.setattr(intelligence_outcomes, "_metrics_for_window", fake_metrics_for_window)
    monkeypatch.setattr(intelligence_outcomes, "persist_outcome_values", fake_persist)

    results = await intelligence_outcomes._evaluate_snapshot_horizons(
        object(),
        snapshot=snapshot,
        horizons=(6, 24, 72),
        now=cutoff + timedelta(hours=80),
    )

    assert metric_reads == 1
    assert persisted == [(6, 2.0), (24, 3.0), (72, 4.0)]
    assert set(results) == {6, 24, 72}
    assert all(result["status"] == "evaluated" for result in results.values())
