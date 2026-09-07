from __future__ import annotations

from sqlalchemy import select

from app.models.advanced_intelligence import (
    CampaignFingerprintActor,
    CampaignFingerprintFeature,
)
from app.services.advanced_intelligence_persistence import (
    persist_advanced_intelligence_state,
)


async def test_persisted_campaign_fingerprint_creates_similarity_projection(
    test_app,
) -> None:
    vector = {
        "schema_v2": 1.0,
        "x_accounts": 0.6,
        "tg_channels": 0.8,
        "wallets": 0.0,
        "bundles": 0.0,
        "shared_links": 0.0,
        "copies": 0.0,
        "amplifies": 0.0,
        "mentions_wallet": 0.0,
        "social_score": 0.0,
        "x_score": 0.0,
        "telegram_score": 0.0,
        "organic": 0.0,
        "manipulation": 0.0,
        "early": 0.0,
        "alpha": 0.0,
        "bot_risk": 0.0,
    }
    snapshot_id = "snapshot-campaign-projection"

    async with test_app.state.sessionmaker() as session:
        await persist_advanced_intelligence_state(
            session,
            snapshot={
                "snapshotId": snapshot_id,
                "mint": "mint-campaign-projection",
            },
            report={
                "layers": {
                    "campaign_fingerprint": {
                        "hash": "fingerprint-hash",
                        "vector": vector,
                        "actors": [
                            "x_account:alpha",
                            "x_account:alpha",
                            "tg_channel:beta",
                        ],
                    },
                    "narrative_engine": {
                        "primary": None,
                        "primary_key": None,
                    },
                }
            },
        )

        projection = await session.get(CampaignFingerprintFeature, snapshot_id)
        actor_rows = list(
            (
                await session.execute(
                    select(CampaignFingerprintActor)
                    .where(CampaignFingerprintActor.snapshot_id == snapshot_id)
                    .order_by(CampaignFingerprintActor.actor_key.asc())
                )
            ).scalars().all()
        )

    assert projection is not None
    assert projection.schema_version == 2
    assert projection.vector_norm == 1.0
    assert projection.actor_count == 2
    assert projection.x_accounts == 0.6
    assert projection.tg_channels == 0.8
    assert [row.actor_key for row in actor_rows] == [
        "tg_channel:beta",
        "x_account:alpha",
    ]
