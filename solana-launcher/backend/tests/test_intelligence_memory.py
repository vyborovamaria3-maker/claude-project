from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.base import Base
from app.models.intelligence_memory import (
    IntelligenceDiscovery,
    IntelligenceEdge,
    IntelligenceEntity,
    IntelligenceSnapshot,
    IntelligenceSnapshotEdge,
    IntelligenceSnapshotEntity,
)
from app.services.intelligence_memory import (
    build_memory_context,
    entity_memory,
    persist_intelligence_memory,
    token_memory_history,
)

MINT = "3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump"
MINT_2 = "So11111111111111111111111111111111111111112"


def snapshot(
    snapshot_id: str = "snapshot-test",
    *,
    mint: str = MINT,
    token_id: str = "token:test",
) -> dict:
    return {
        "snapshotId": snapshot_id,
        "version": "social-snapshot-v2",
        "graphVersion": "entity-graph-v1.1",
        "mint": mint,
        "symbol": "TEST",
        "tokenName": "Test Token",
        "featureCount": 2,
        "missingFeatureCount": 0,
        "features": [
            {"key": "scores.social", "value": 78},
            {"key": "scores.alpha", "value": 71},
        ],
        "graph": {
            "version": "entity-graph-v1.1",
            "nodes": [
                {
                    "id": token_id,
                    "type": "token",
                    "label": "TEST",
                    "attributes": {"mint": mint},
                },
                {
                    "id": "tg_channel:alpha",
                    "type": "tg_channel",
                    "label": "@alpha",
                    "attributes": {},
                },
                {
                    "id": "x_account:beta",
                    "type": "x_account",
                    "label": "@beta",
                    "attributes": {},
                },
            ],
            "edges": [
                {
                    "id": "edge:call",
                    "source": "tg_channel:alpha",
                    "target": token_id,
                    "type": "calls",
                    "confidence": 0.9,
                    "evidenceIds": ["ev-1"],
                    "attributes": {},
                },
                {
                    "id": "edge:amplify",
                    "source": "tg_channel:alpha",
                    "target": "x_account:beta",
                    "type": "amplifies",
                    "confidence": 0.8,
                    "evidenceIds": ["ev-1", "ev-2"],
                    "attributes": {"lagSeconds": 90},
                },
            ],
            "stats": {},
        },
        "evidence": [],
        "rawSummary": {},
    }


def ai_result() -> dict:
    return {
        "overallConfidence": 0.82,
        "discoveredRelationships": [
            {
                "source": "@alpha",
                "target": "@beta",
                "type": "likely_amplifier",
                "status": "hypothesis",
                "confidence": 0.77,
                "rationale": "The X account followed the Telegram signal.",
                "evidenceMessageIds": ["ev-1", "ev-2"],
            }
        ],
        "anomalies": [
            {
                "type": "velocity_mismatch",
                "confidence": 0.66,
                "explanation": "Social velocity rose faster than breadth.",
                "evidenceMessageIds": ["ev-1"],
                "relatedFeatureKeys": ["scores.social"],
            }
        ],
        "contradictions": [],
    }


@pytest.mark.asyncio
async def test_persistent_memory_is_idempotent_and_unique_mint_aware() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(
            lambda sync_connection: Base.metadata.create_all(
                sync_connection,
                tables=[
                    IntelligenceSnapshot.__table__,
                    IntelligenceEntity.__table__,
                    IntelligenceSnapshotEntity.__table__,
                    IntelligenceEdge.__table__,
                    IntelligenceSnapshotEdge.__table__,
                    IntelligenceDiscovery.__table__,
                ],
            )
        )

    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        base = snapshot()
        analysis_snapshot = {
            **base,
            "featureCount": 3,
            "features": [
                *base["features"],
                {"key": "memory.stats.prior_snapshots", "value": 0},
            ],
        }
        stored = await persist_intelligence_memory(
            session,
            snapshot=base,
            analysis_snapshot=analysis_snapshot,
            ai_result=ai_result(),
            provider="openai-compatible",
            model="Qwen/Qwen2.5-7B-Instruct",
            prompt_version="intelligence-qwen-v4-memory",
        )
        assert stored["status"] == "stored"
        assert stored["entities"] == 3
        assert stored["edges"] == 2
        assert stored["discoveries"] == 2

        duplicate = await persist_intelligence_memory(
            session,
            snapshot=base,
            ai_result=ai_result(),
        )
        assert duplicate["status"] == "exists"

        same_mint_refresh = await persist_intelligence_memory(
            session,
            snapshot=snapshot("snapshot-refresh"),
            ai_result=ai_result(),
        )
        assert same_mint_refresh["status"] == "stored"

        entity = await entity_memory(session, "tg_channel:alpha")
        assert entity is not None
        assert entity["entity"]["occurrence_count"] == 1
        amplify = next(item for item in entity["edges"] if item["type"] == "amplifies")
        assert amplify["occurrence_count"] == 1
        assert amplify["avg_confidence"] == pytest.approx(0.8)
        assert any(
            item["type"] == "likely_amplifier"
            and item["source"] == "tg_channel:alpha"
            and item["target"] == "x_account:beta"
            for item in entity["discoveries"]
        )

        second_mint = await persist_intelligence_memory(
            session,
            snapshot=snapshot(
                "snapshot-second-token",
                mint=MINT_2,
                token_id="token:test-2",
            ),
            ai_result=ai_result(),
        )
        assert second_mint["status"] == "stored"

        entity_after_second_mint = await entity_memory(session, "tg_channel:alpha")
        assert entity_after_second_mint is not None
        assert entity_after_second_mint["entity"]["occurrence_count"] == 2
        amplify_after = next(
            item
            for item in entity_after_second_mint["edges"]
            if item["type"] == "amplifies"
        )
        assert amplify_after["occurrence_count"] == 2
        assert amplify_after["avg_confidence"] == pytest.approx(0.8)

        history = await token_memory_history(session, MINT)
        assert len(history) == 2
        assert history[-1]["prompt_version"] == "intelligence-qwen-v4-memory"

        first_row = await session.get(IntelligenceSnapshot, "snapshot-test")
        assert first_row is not None
        assert first_row.analysis_payload is not None
        assert first_row.feature_count == 3

        context = await build_memory_context(
            session,
            entity_keys=["tg_channel:alpha", "x_account:beta"],
            mint=MINT,
        )
        assert context["stats"]["matched_entities"] == 2
        assert context["stats"]["historical_edges"] >= 1
        assert context["stats"]["historical_discoveries"] == 1
        assert context["stats"]["prior_snapshots"] == 2

    await engine.dispose()
