from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from app.models.advanced_intelligence import IntelligenceOutcome
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


async def test_matured_selection_skips_fully_evaluated_old_history(
    test_app,
    monkeypatch,
) -> None:
    now = datetime.now(timezone.utc)
    snapshots = [
        IntelligenceSnapshot(
            snapshot_id=f"snapshot-history-{index}",
            mint_address=f"mint-history-{index}",
            snapshot_version="snapshot-v1",
            graph_version="graph-v1",
            feature_count=0,
            missing_feature_count=0,
            payload={"features": []},
            created_at=now - timedelta(days=10) + timedelta(hours=index),
        )
        for index in range(6)
    ]

    async with test_app.state.sessionmaker() as session:
        session.add_all(snapshots)
        for snapshot in snapshots[:5]:
            for horizon in (6, 24, 72):
                session.add(
                    IntelligenceOutcome(
                        snapshot_id=snapshot.snapshot_id,
                        mint_address=snapshot.mint_address,
                        horizon_hours=horizon,
                        max_multiple=1.0,
                        outcome_label="sub_2x",
                    )
                )
        await session.commit()

        selected: list[str] = []

        async def fake_evaluate(session_arg, *, snapshot, horizons, now):
            del session_arg, now
            selected.append(snapshot.snapshot_id)
            return {
                int(horizon): {"status": "evaluated"}
                for horizon in horizons
            }

        monkeypatch.setattr(
            intelligence_outcomes,
            "_evaluate_snapshot_horizons",
            fake_evaluate,
        )
        result = await intelligence_outcomes.evaluate_matured_outcomes(
            session,
            horizons=(6, 24, 72),
            now=now,
            limit=1,
        )

        assert selected == [snapshots[5].snapshot_id]
        assert result["snapshots"] == 1
        assert result["candidates_scanned"] == 1
        assert result["evaluated"] == 3
