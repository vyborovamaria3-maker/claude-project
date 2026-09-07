from __future__ import annotations

from sqlalchemy import event, select

from app.models.advanced_intelligence import IntelligenceHypothesisState
from app.services.advanced_intelligence_persistence import persist_advanced_intelligence_state


async def test_hypothesis_persistence_uses_one_existing_state_lookup(test_app) -> None:
    report = {
        "layers": {
            "campaign_fingerprint": {
                "hash": "fingerprint-1",
                "vector": {"schema_v2": 1.0, "x_accounts": 0.2},
                "actors": ["x_account:alpha"],
            },
            "narrative_engine": {
                "primary": None,
                "primary_key": None,
            },
        }
    }
    discoveries = [
        {
            "type": "coordinates_with",
            "source": f"x_account:source-{index}",
            "target": f"tg_channel:target-{index}",
            "status": "supported",
            "confidence": 0.75,
            "evidenceMessageIds": [f"message-{index}"],
        }
        for index in range(60)
    ]
    ai_result = {"discoveredRelationships": discoveries}
    snapshot = {"snapshotId": "snapshot-persist-hot", "mint": "mint-persist-hot"}

    async with test_app.state.sessionmaker() as session:
        select_count = 0

        def count_selects(*args) -> None:
            nonlocal select_count
            statement = str(args[2]).lstrip().upper()
            if statement.startswith("SELECT"):
                select_count += 1

        event.listen(test_app.state.engine.sync_engine, "before_cursor_execute", count_selects)
        try:
            await persist_advanced_intelligence_state(
                session,
                snapshot=snapshot,
                report=report,
                ai_result=ai_result,
            )
        finally:
            event.remove(
                test_app.state.engine.sync_engine,
                "before_cursor_execute",
                count_selects,
            )

        # Fixed query count: campaign fingerprint lookup + one hypothesis lookup.
        # It must not grow with the 60 discovered relationships above.
        assert select_count == 2
        states = list(
            (
                await session.execute(
                    select(IntelligenceHypothesisState).order_by(
                        IntelligenceHypothesisState.hypothesis_key.asc()
                    )
                )
            ).scalars().all()
        )
        assert len(states) == 60
        assert all(row.support_count == 1 for row in states)

        # Replaying the same snapshot is idempotent at the mint-vote level and
        # still performs one bulk existing-state lookup rather than 60 SELECTs.
        replay_selects = 0

        def count_replay_selects(*args) -> None:
            nonlocal replay_selects
            statement = str(args[2]).lstrip().upper()
            if statement.startswith("SELECT"):
                replay_selects += 1

        event.listen(
            test_app.state.engine.sync_engine,
            "before_cursor_execute",
            count_replay_selects,
        )
        try:
            await persist_advanced_intelligence_state(
                session,
                snapshot=snapshot,
                report=report,
                ai_result=ai_result,
            )
        finally:
            event.remove(
                test_app.state.engine.sync_engine,
                "before_cursor_execute",
                count_replay_selects,
            )

        assert replay_selects == 2
        replayed = list(
            (
                await session.execute(select(IntelligenceHypothesisState))
            ).scalars().all()
        )
        assert len(replayed) == 60
        assert all(row.support_count == 1 for row in replayed)
