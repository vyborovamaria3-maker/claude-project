from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import event, select

from app.models.advanced_intelligence import IntelligenceEntityOutcomeProjection
from app.models.intelligence_memory import IntelligenceSnapshot, IntelligenceSnapshotEntity
from app.services.advanced_intelligence_enrichment import performance_aware_source_reliability
from app.services.intelligence_outcomes import persist_outcome_values


def _snapshot(snapshot_id: str, mint: str, created_at: datetime) -> IntelligenceSnapshot:
    return IntelligenceSnapshot(
        snapshot_id=snapshot_id,
        mint_address=mint,
        snapshot_version="snapshot-v1",
        graph_version="graph-v1",
        feature_count=0,
        missing_feature_count=0,
        payload={"features": []},
        created_at=created_at,
    )


def _link(snapshot_id: str, entity_key: str) -> IntelligenceSnapshotEntity:
    return IntelligenceSnapshotEntity(
        snapshot_id=snapshot_id,
        entity_key=entity_key,
        entity_type="x_account",
        label=entity_key,
    )


async def test_entity_performance_projection_uses_earliest_snapshot_and_one_hot_read(
    test_app,
) -> None:
    now = datetime.now(timezone.utc)
    actor = "x_account:alpha"
    mint_a = "mint-a"
    mint_b = "mint-b"

    first = _snapshot("snap-a-first", mint_a, now - timedelta(days=10))
    later = _snapshot("snap-a-later", mint_a, now - timedelta(days=9))
    other = _snapshot("snap-b-first", mint_b, now - timedelta(days=8))

    async with test_app.state.sessionmaker() as session:
        session.add_all(
            [
                first,
                later,
                other,
                _link(first.snapshot_id, actor),
                _link(later.snapshot_id, actor),
                _link(other.snapshot_id, actor),
            ]
        )
        await session.commit()

        # A later snapshot outcome must not create a vote while the earliest
        # appearance for the same entity+mint has no matured outcome yet.
        await persist_outcome_values(
            session,
            snapshot=later,
            horizon_hours=72,
            baseline_price_usd=1.0,
            max_price_usd=8.0,
            min_price_usd=0.5,
            final_price_usd=2.0,
            max_drawdown_pct=-40.0,
        )
        await session.commit()
        assert (
            await session.execute(select(IntelligenceEntityOutcomeProjection))
        ).scalars().all() == []

        await persist_outcome_values(
            session,
            snapshot=first,
            horizon_hours=72,
            baseline_price_usd=1.0,
            max_price_usd=3.0,
            min_price_usd=0.1,
            final_price_usd=1.2,
            max_drawdown_pct=-90.0,
        )
        await persist_outcome_values(
            session,
            snapshot=other,
            horizon_hours=72,
            baseline_price_usd=1.0,
            max_price_usd=1.5,
            min_price_usd=0.1,
            final_price_usd=0.4,
            max_drawdown_pct=-85.0,
        )
        await session.commit()

        rows = list(
            (
                await session.execute(
                    select(IntelligenceEntityOutcomeProjection).order_by(
                        IntelligenceEntityOutcomeProjection.mint_address.asc()
                    )
                )
            ).scalars().all()
        )
        assert len(rows) == 2
        assert rows[0].snapshot_id == first.snapshot_id
        assert rows[0].max_multiple == 3.0
        assert rows[1].snapshot_id == other.snapshot_id
        assert rows[1].max_multiple == 1.5

        # Revising the earliest outcome updates the projection instead of adding
        # another entity/token vote.
        await persist_outcome_values(
            session,
            snapshot=first,
            horizon_hours=72,
            baseline_price_usd=1.0,
            max_price_usd=4.0,
            min_price_usd=0.1,
            final_price_usd=1.5,
            max_drawdown_pct=-90.0,
        )
        await session.commit()

        select_count = 0

        def count_selects(*args) -> None:
            nonlocal select_count
            statement = str(args[2]).lstrip().upper()
            if statement.startswith("SELECT"):
                select_count += 1

        event.listen(test_app.state.engine.sync_engine, "before_cursor_execute", count_selects)
        try:
            enriched = await performance_aware_source_reliability(
                session,
                {
                    "graph": {
                        "nodes": [
                            {
                                "id": actor,
                                "type": "x_account",
                            }
                        ]
                    }
                },
                [
                    {
                        "entity": actor,
                        "type": "x_account",
                        "distinct_token_occurrences": 2,
                    }
                ],
            )
        finally:
            event.remove(
                test_app.state.engine.sync_engine,
                "before_cursor_execute",
                count_selects,
            )

        assert select_count == 1
        assert len(enriched) == 1
        result = enriched[0]
        assert result["matured_72h_samples"] == 2
        assert result["historical_2x_rate_72h"] == 0.5
        assert result["historical_collapse_rate_72h"] == 1.0
        assert result["median_max_multiple_72h"] == 2.75
        assert result["performance_source"] == "intelligence_entity_outcomes_projection"
