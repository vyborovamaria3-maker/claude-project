from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.base import Base
from app.models.intelligence_memory import (
    IntelligenceDiscovery,
    IntelligenceEdge,
    IntelligenceEntity,
    IntelligenceSnapshot,
    IntelligenceSnapshotEntity,
)
from app.services.intelligence_memory import (
    build_memory_context,
    entity_memory,
    persist_intelligence_memory,
    token_memory_history,
)

MINT = "3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump"


def snapshot(snapshot_id: str = "snapshot-test") -> dict:
    return {
        "snapshotId": snapshot_id,
        "version": "social-snapshot-v2",
        "graphVersion": "entity-graph-v1.1",
        "mint": MINT,
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
                    "id": "token:test",
                    "type": "token",
                    "label": "TEST",
                    "attributes": {"mint": MINT},
                },
                {
                    "id": "tg_channel:alpha",
                    "type": "tg_channel",
                    "label": "@alpha",
                    "attributes": {},
                },
            ],
            "edges": [
                {
                    "id": "edge:call",
                    "source": "tg_channel:alpha",
                    "target": "token:test",
                    "type": "calls",
                    "confidence": 0.9,
                    "evidenceIds": ["ev-1"],
                    "attributes": {},
                }
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
                "source": "tg_channel:alpha",
                "target": "token:test",
                "type": "likely_originator",
                "status": "hypothesis",
                "confidence": 0.77,
                "rationale": "Channel appeared first in the observed window.",
                "evidenceMessageIds": ["ev-1"],
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
async def test_persistent_memory_is_idempotent_and_queryable() -> None:
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
                    IntelligenceDiscovery.__table__,
                ],
            )
        )

    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        stored = await persist_intelligence_memory(
            session,
            snapshot=snapshot(),
            ai_result=ai_result(),
            provider="openai-compatible",
            model="Qwen/Qwen2.5-7B-Instruct",
            prompt_version="intelligence-qwen-v4-memory",
        )
        assert stored["status"] == "stored"
        assert stored["entities"] == 2
        assert stored["edges"] == 1
        assert stored["discoveries"] == 2

        duplicate = await persist_intelligence_memory(
            session,
            snapshot=snapshot(),
            ai_result=ai_result(),
        )
        assert duplicate["status"] == "exists"

        history = await token_memory_history(session, MINT)
        assert len(history) == 1
        assert history[0]["prompt_version"] == "intelligence-qwen-v4-memory"

        entity = await entity_memory(session, "tg_channel:alpha")
        assert entity is not None
        assert entity["entity"]["occurrence_count"] == 1
        assert entity["edges"][0]["occurrence_count"] == 1
        assert entity["edges"][0]["avg_confidence"] == pytest.approx(0.9)
        assert any(item["type"] == "likely_originator" for item in entity["discoveries"])

        context = await build_memory_context(
            session,
            entity_keys=["tg_channel:alpha", "token:test"],
            mint=MINT,
        )
        assert context["stats"]["matched_entities"] == 2
        assert context["stats"]["historical_edges"] == 1
        assert context["stats"]["historical_discoveries"] == 1
        assert context["stats"]["prior_snapshots"] == 1

    await engine.dispose()
