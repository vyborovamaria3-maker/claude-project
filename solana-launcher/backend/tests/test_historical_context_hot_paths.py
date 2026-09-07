from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.models.advanced_intelligence import IntelligenceHypothesisState
from app.services.advanced_intelligence import _historical_context


async def test_historical_context_filters_hypotheses_before_limit(test_app) -> None:
    now = datetime.now(timezone.utc)
    actor = "x_account:relevant-actor"
    mint = "mint-current"

    relevant = [
        IntelligenceHypothesisState(
            hypothesis_key="relevant-by-source",
            mint_address="mint-old-source",
            hypothesis_type="possible_same_operator",
            source_key=actor,
            target_key="wallet:other",
            status="supported",
            confidence=0.8,
            updated_at=now - timedelta(days=30),
        ),
        IntelligenceHypothesisState(
            hypothesis_key="relevant-by-target",
            mint_address="mint-old-target",
            hypothesis_type="possible_same_operator",
            source_key="x_account:other",
            target_key=actor,
            status="contradicted",
            confidence=0.4,
            updated_at=now - timedelta(days=29),
        ),
        IntelligenceHypothesisState(
            hypothesis_key="relevant-by-mint",
            mint_address=mint,
            hypothesis_type="campaign_pattern",
            source_key=None,
            target_key=None,
            status="strengthened",
            confidence=0.9,
            updated_at=now - timedelta(days=28),
        ),
    ]
    irrelevant = [
        IntelligenceHypothesisState(
            hypothesis_key=f"irrelevant-{index}",
            mint_address=f"mint-irrelevant-{index}",
            hypothesis_type="noise",
            source_key=f"x_account:noise-{index}",
            target_key=f"wallet:noise-{index}",
            status="supported",
            confidence=0.5,
            updated_at=now - timedelta(minutes=index),
        )
        for index in range(301)
    ]

    async with test_app.state.sessionmaker() as session:
        session.add_all([*relevant, *irrelevant])
        await session.commit()

        historical = await _historical_context(
            session,
            {
                "mint": mint,
                "graph": {
                    "nodes": [{"id": actor, "type": "x_account"}],
                    "edges": [],
                },
                "features": [],
                "evidence": [],
            },
            {
                "vector": {"schema_v2": 1.0},
                "actors": [actor],
            },
        )

    keys = {row["hypothesis_key"] for row in historical["hypotheses"]}
    assert keys == {
        "relevant-by-source",
        "relevant-by-target",
        "relevant-by-mint",
    }
    assert [row["hypothesis_key"] for row in historical["negative_memory"]] == [
        "relevant-by-target"
    ]
