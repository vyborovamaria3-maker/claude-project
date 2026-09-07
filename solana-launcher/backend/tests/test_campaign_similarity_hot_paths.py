from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import event

from app.models.advanced_intelligence import (
    CampaignFingerprint,
    CampaignFingerprintActor,
    CampaignFingerprintFeature,
)
from app.services.campaign_similarity import (
    find_campaign_neighbors,
    prepare_campaign_projection,
)


def _vector(**overrides: float) -> dict[str, float]:
    value = {
        "schema_v2": 1.0,
        "x_accounts": 0.0,
        "tg_channels": 0.0,
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
    value.update(overrides)
    return value


def _fingerprint_rows(
    *,
    snapshot_id: str,
    mint: str,
    vector: dict[str, float],
    actors: list[str],
    created_at: datetime,
):
    projection, actor_keys = prepare_campaign_projection(vector, actors)
    assert projection is not None
    return [
        CampaignFingerprint(
            snapshot_id=snapshot_id,
            mint_address=mint,
            fingerprint_hash=f"hash-{snapshot_id}",
            vector=vector,
            actors=actors,
            narratives=[],
            created_at=created_at,
        ),
        CampaignFingerprintFeature(
            snapshot_id=snapshot_id,
            mint_address=mint,
            created_at=created_at,
            **projection,
        ),
        *[
            CampaignFingerprintActor(
                snapshot_id=snapshot_id,
                actor_key=actor_key,
            )
            for actor_key in actor_keys
        ],
    ]


async def test_campaign_neighbors_use_one_exact_sql_query_and_dedupe_mints(
    test_app,
) -> None:
    now = datetime.now(timezone.utc)
    current_vector = _vector(x_accounts=1.0)
    actor = "x_account:alpha"

    async with test_app.state.sessionmaker() as session:
        rows = []
        # Older snapshot for mint-a is the stronger match because it shares the
        # actor as well as an identical numeric vector.
        rows.extend(
            _fingerprint_rows(
                snapshot_id="snap-a-strong",
                mint="mint-a",
                vector=_vector(x_accounts=1.0),
                actors=[actor],
                created_at=now - timedelta(hours=3),
            )
        )
        rows.extend(
            _fingerprint_rows(
                snapshot_id="snap-a-newer-weaker",
                mint="mint-a",
                vector=_vector(x_accounts=1.0),
                actors=[],
                created_at=now - timedelta(hours=1),
            )
        )
        rows.extend(
            _fingerprint_rows(
                snapshot_id="snap-b",
                mint="mint-b",
                vector=_vector(x_accounts=1.0),
                actors=[],
                created_at=now - timedelta(hours=2),
            )
        )
        # Actor-only similarity is 0.25 and must remain below the 0.5 contract.
        rows.extend(
            _fingerprint_rows(
                snapshot_id="snap-c-actor-only",
                mint="mint-c",
                vector=_vector(tg_channels=1.0),
                actors=[actor],
                created_at=now - timedelta(minutes=30),
            )
        )
        # History for the currently analysed mint must not compete with neighbors.
        rows.extend(
            _fingerprint_rows(
                snapshot_id="snap-current-old",
                mint="mint-current",
                vector=_vector(x_accounts=1.0),
                actors=[actor],
                created_at=now - timedelta(minutes=10),
            )
        )
        session.add_all(rows)
        await session.commit()

        select_count = 0

        def count_selects(*args) -> None:
            nonlocal select_count
            statement = str(args[2]).lstrip().upper()
            if statement.startswith("WITH") or statement.startswith("SELECT"):
                select_count += 1

        event.listen(
            test_app.state.engine.sync_engine,
            "before_cursor_execute",
            count_selects,
        )
        try:
            neighbors = await find_campaign_neighbors(
                session,
                current_mint="mint-current",
                current_vector=current_vector,
                current_actors=[actor],
            )
        finally:
            event.remove(
                test_app.state.engine.sync_engine,
                "before_cursor_execute",
                count_selects,
            )

    assert select_count == 1
    assert [row["mint"] for row in neighbors] == ["mint-a", "mint-b"]
    assert neighbors[0]["snapshot_id"] == "snap-a-strong"
    assert neighbors[0]["vector_similarity"] == 1.0
    assert neighbors[0]["actor_similarity"] == 1.0
    assert neighbors[0]["similarity"] == 1.0
    assert neighbors[1]["similarity"] == 0.75


def test_campaign_projection_deduplicates_actor_membership() -> None:
    projection, actors = prepare_campaign_projection(
        _vector(x_score=1.0),
        ["x_account:a", "x_account:a", "tg_channel:b"],
    )
    assert projection is not None
    assert actors == ["tg_channel:b", "x_account:a"]
    assert projection["actor_count"] == 2
    assert projection["vector_norm"] == 1.0
