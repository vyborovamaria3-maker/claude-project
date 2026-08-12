from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.base import Base
from app.models.advanced_intelligence import (
    CampaignFingerprint,
    IntelligenceHypothesisState,
)
from app.models.intelligence_memory import IntelligenceEntity
from app.services.advanced_intelligence import build_advanced_intelligence_report
from app.services.advanced_intelligence_persistence import (
    persist_advanced_intelligence_state,
)

MINT = "3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump"
MINT_2 = "So11111111111111111111111111111111111111112"


def snapshot(
    snapshot_id: str = "advanced-test-1",
    mint: str = MINT,
) -> dict:
    return {
        "snapshotId": snapshot_id,
        "version": "social-snapshot-v2",
        "graphVersion": "entity-graph-v1.1",
        "mint": mint,
        "symbol": "TEST",
        "tokenName": "Test Token",
        "featureCount": 8,
        "missingFeatureCount": 0,
        "features": [
            {"key": "x.score", "numericValue": 88, "value": 88},
            {"key": "tg.score", "numericValue": 45, "value": 45},
            {"key": "x.mentions", "numericValue": 100, "value": 100},
            {"key": "x.authors", "numericValue": 10, "value": 10},
            {"key": "x.engagement", "numericValue": 600000, "value": 600000},
            {"key": "tg.mentions", "numericValue": 60, "value": 60},
            {"key": "tg.channels", "numericValue": 3, "value": 3},
            {"key": "combined.alpha", "numericValue": 80, "value": 80},
        ],
        "graph": {
            "version": "entity-graph-v1.1",
            "stats": {
                "nodes": 7,
                "edges": 8,
                "xAccounts": 2,
                "tgChannels": 1,
                "wallets": 2,
                "bundles": 1,
                "socialWalletLinks": 2,
                "sharedLinks": 2,
                "copyEdges": 0,
                "amplificationEdges": 1,
            },
            "nodes": [
                {"id": "token:test", "type": "token", "label": "TEST", "attributes": {}},
                {"id": "x_account:a", "type": "x_account", "label": "@a", "attributes": {"suspicious": True}},
                {"id": "x_account:b", "type": "x_account", "label": "@b", "attributes": {}},
                {"id": "tg_channel:c", "type": "tg_channel", "label": "@c", "attributes": {}},
                {"id": "wallet:w1", "type": "wallet", "label": "w1", "attributes": {"smart": True}},
                {"id": "wallet:w2", "type": "wallet", "label": "w2", "attributes": {}},
                {"id": "bundle:1", "type": "bundle", "label": "Bundle 1", "attributes": {}},
            ],
            "edges": [
                {"id": "e1", "source": "wallet:w1", "target": "bundle:1", "type": "bundle_member", "confidence": 1, "evidenceIds": [], "attributes": {}},
                {"id": "e2", "source": "wallet:w2", "target": "bundle:1", "type": "bundle_member", "confidence": 1, "evidenceIds": [], "attributes": {}},
                {"id": "e3", "source": "x_account:a", "target": "url:u", "type": "shared_link", "confidence": 1, "evidenceIds": ["ev1"], "attributes": {}},
                {"id": "e4", "source": "x_account:b", "target": "url:u", "type": "shared_link", "confidence": 1, "evidenceIds": ["ev2"], "attributes": {}},
                {"id": "e5", "source": "x_account:a", "target": "wallet:w1", "type": "mentions_wallet", "confidence": 1, "evidenceIds": ["ev1"], "attributes": {}},
                {"id": "e6", "source": "tg_channel:c", "target": "wallet:w1", "type": "mentions_wallet", "confidence": 1, "evidenceIds": ["ev3"], "attributes": {}},
                {"id": "e7", "source": "tg_channel:c", "target": "x_account:b", "type": "amplifies", "confidence": 0.8, "evidenceIds": ["ev3", "ev2"], "attributes": {"lagSeconds": 90}},
                {"id": "e8", "source": "wallet:w1", "target": "token:test", "type": "trades", "confidence": 1, "evidenceIds": [], "attributes": {}},
            ],
        },
        "evidence": [
            {"id": "ev1", "platform": "x", "source": "@a", "text": "same campaign text alpha alpha alpha", "timestamp": "2026-08-12T00:00:00Z"},
            {"id": "ev2", "platform": "x", "source": "@b", "text": "same campaign text alpha alpha alpha", "timestamp": "2026-08-12T00:01:00Z"},
            {"id": "ev3", "platform": "telegram", "source": "@c", "text": "same campaign text alpha alpha alpha", "timestamp": "2026-08-12T00:02:00Z"},
        ],
        "rawSummary": {
            "xPosts": 2,
            "telegramMessages": 1,
            "trades": 10,
            "wallets": 2,
            "bundles": 1,
            "chainTruncated": False,
            "marketAvailable": True,
        },
    }


AI_RESULT = {
    "campaignHypothesis": {
        "narrative": "AI meme early launch",
        "label": "mixed",
        "confidence": 0.72,
    },
    "discoveredRelationships": [
        {
            "source": "tg_channel:c",
            "target": "x_account:b",
            "type": "likely_amplifier",
            "status": "hypothesis",
            "confidence": 0.75,
            "evidenceMessageIds": ["ev2", "ev3"],
            "supportingFeatureKeys": [],
        }
    ],
    "anomalies": [],
    "contradictions": [],
}


@pytest.mark.asyncio
async def test_advanced_intelligence_has_exact_20_layers_and_no_fake_funding() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as session:
        report = await build_advanced_intelligence_report(
            session,
            snapshot=snapshot(),
            ai_result=AI_RESULT,
        )
        assert report["layer_count"] == 20
        assert len(report["layers"]) == 20
        assert report["layers"]["funding_verification"]["status"] == "insufficient_data"
        assert report["layers"]["funding_verification"]["verified_by_rpc"] is False
        assert len(report["layers"]["wallet_clusters"]["clusters"]) == 1
        assert report["layers"]["identity_resolution"]["candidates"]
        assert report["layers"]["contradictions"]["anomaly_discovery"]["count"] >= 1
        assert report["layers"]["dedicated_critic"]["required"] is True
    await engine.dispose()


@pytest.mark.asyncio
async def test_hypothesis_reputation_uses_distinct_mints_not_refresh_count() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as session:
        session.add(
            IntelligenceEntity(
                entity_key="tg_channel:c",
                entity_type="tg_channel",
                label="@c",
                occurrence_count=4,
            )
        )
        await session.commit()
        first = snapshot()
        report = await build_advanced_intelligence_report(
            session,
            snapshot=first,
            ai_result=AI_RESULT,
        )
        await persist_advanced_intelligence_state(
            session,
            snapshot=first,
            report=report,
            ai_result=AI_RESULT,
            role="analyst",
        )
        await persist_advanced_intelligence_state(
            session,
            snapshot={**first, "snapshotId": "refresh-same-mint"},
            report=report,
            ai_result=AI_RESULT,
            role="analyst",
        )
        second = snapshot("other-token-snapshot", MINT_2)
        second_report = await build_advanced_intelligence_report(
            session,
            snapshot=second,
            ai_result=AI_RESULT,
        )
        await persist_advanced_intelligence_state(
            session,
            snapshot=second,
            report=second_report,
            ai_result=AI_RESULT,
            role="analyst",
        )
        fingerprints = list(
            (await session.execute(select(CampaignFingerprint))).scalars().all()
        )
        hypotheses = list(
            (await session.execute(select(IntelligenceHypothesisState))).scalars().all()
        )
        assert len(fingerprints) == 3
        assert len(hypotheses) == 1
        assert hypotheses[0].support_count == 2
        assert len(hypotheses[0].observations or {}) == 2
        assert report["layers"]["source_reliability"][0]["distinct_token_occurrences"] == 4
    await engine.dispose()


@pytest.mark.asyncio
async def test_critic_can_override_same_mint_without_extra_vote() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as session:
        snap = snapshot()
        report = await build_advanced_intelligence_report(
            session,
            snapshot=snap,
            ai_result=AI_RESULT,
        )
        await persist_advanced_intelligence_state(
            session,
            snapshot=snap,
            report=report,
            ai_result=AI_RESULT,
            role="analyst",
        )
        critic_result = {
            **AI_RESULT,
            "discoveredRelationships": [
                {
                    **AI_RESULT["discoveredRelationships"][0],
                    "status": "contradicted",
                    "confidence": 0.9,
                }
            ],
        }
        await persist_advanced_intelligence_state(
            session,
            snapshot=snap,
            report=report,
            ai_result=critic_result,
            role="critic",
        )
        row = (
            await session.execute(select(IntelligenceHypothesisState))
        ).scalar_one()
        assert row.support_count == 0
        assert row.contradiction_count == 1
        assert len(row.observations or {}) == 1
        assert row.status == "contradicted"
    await engine.dispose()
