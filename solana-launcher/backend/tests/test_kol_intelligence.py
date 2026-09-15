from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import func, select

from app.api.v1 import advanced_intelligence as advanced_api
from app.models.analytics import Wallet
from app.models.kol_intelligence import (
    KOLProfile,
    KOLSourceSync,
    KOLTradeEvent,
    KOLWalletAttribution,
    KOLWalletEvidence,
    KOLWalletMetric,
)
from app.services.kol_metrics import refresh_kol_metrics
from tests.conftest import TEST_BACKEND_API_KEY, TEST_KOL_INTERNAL_KEY

BACKEND_HEADERS = {"X-Backend-API-Key": TEST_BACKEND_API_KEY}
KOL_HEADERS = {"X-KOL-Internal-Key": TEST_KOL_INTERNAL_KEY}
SOL_ADDRESS = "11111111111111111111111111111111"
MINT = "So11111111111111111111111111111111111111112"


def sync_payload(
    *,
    handle: str = "test_kol",
    confidence: float = 100,
    verified: bool = True,
    avatar: str | None = "https://example.com/avatar.png",
    telegram: str | None = "https://t.me/test_kol",
    source: str = "Next.ID",
    wallet_confidence: float = 100,
    metrics: dict | None = None,
) -> dict:
    profile: dict = {
        "handle": handle,
        "name": "Test KOL",
        "twitterUrl": f"https://x.com/{handle}",
        "confidence": confidence,
        "verified": verified,
        "sources": [source],
        "wallets": [
            {
                "address": SOL_ADDRESS,
                "chain": "solana",
                "confidence": wallet_confidence,
                "verified": verified,
                "evidence": [
                    {
                        "source": source,
                        "kind": "signed_proof" if verified else "curated_label",
                        "confidence": wallet_confidence,
                        "verified": verified,
                        "detail": f"{source} test evidence",
                        "url": "https://next.id/" if source == "Next.ID" else "https://example.com/",
                    }
                ],
                "metrics": metrics or {},
            }
        ],
    }
    if avatar is not None:
        profile["avatar"] = avatar
    if telegram is not None:
        profile["telegramUrl"] = telegram
    return {
        "items": [profile],
        "sourceStatus": [{"source": source, "ok": True, "detail": "test"}],
    }


@pytest.mark.asyncio
async def test_kol_sync_requires_backend_key(client):
    response = await client.post("/api/v1/kols/sync", json={"items": [], "sourceStatus": []})
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_internal_sync_requires_scoped_key(client):
    response = await client.post(
        "/api/v1/kols/internal/sync",
        json={"items": [], "sourceStatus": []},
    )
    assert response.status_code == 401

    accepted = await client.post(
        "/api/v1/kols/internal/sync",
        json={"items": [], "sourceStatus": []},
        headers=KOL_HEADERS,
    )
    assert accepted.status_code == 200, accepted.text


@pytest.mark.asyncio
async def test_kol_sync_is_db_idempotent_and_timeframe_specific(client, test_app):
    payload = sync_payload(
        metrics={
            "pnl1dSol": 0.5,
            "wins1d": 1,
            "losses1d": 1,
            "winRate1d": 50,
            "pnl7dSol": 1.25,
            "wins7d": 3,
            "losses7d": 1,
            "winRate7d": 75,
            "pnl30dSol": 4.5,
            "wins30d": 8,
            "losses30d": 2,
            "winRate30d": 80,
        }
    )

    first = await client.post("/api/v1/kols/sync", json=payload, headers=BACKEND_HEADERS)
    second = await client.post("/api/v1/kols/sync", json=payload, headers=BACKEND_HEADERS)

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text

    async with test_app.state.sessionmaker() as session:
        assert (await session.execute(select(func.count(KOLProfile.id)))).scalar_one() == 1
        assert (await session.execute(select(func.count(KOLWalletAttribution.id)))).scalar_one() == 1
        assert (await session.execute(select(func.count(KOLWalletEvidence.id)))).scalar_one() == 1
        metrics = list(
            (
                await session.execute(
                    select(KOLWalletMetric)
                    .where(KOLWalletMetric.source == "resolver")
                    .order_by(KOLWalletMetric.timeframe_days.asc())
                )
            ).scalars().all()
        )
        assert [(row.timeframe_days, row.wins, row.losses, row.win_rate) for row in metrics] == [
            (1, 1, 1, 50),
            (7, 3, 1, 75),
            (30, 8, 2, 80),
        ]
        source = (
            await session.execute(select(KOLSourceSync).where(KOLSourceSync.source == "Next.ID"))
        ).scalar_one()
        assert source.records_seen == 1


@pytest.mark.asyncio
async def test_partial_sync_preserves_verified_profile_data(client, test_app):
    strong = sync_payload(confidence=100, verified=True)
    weak = sync_payload(
        confidence=30,
        verified=False,
        avatar=None,
        telegram=None,
        source="KOL Quest / KolScan",
        wallet_confidence=70,
    )

    assert (await client.post("/api/v1/kols/sync", json=strong, headers=BACKEND_HEADERS)).status_code == 200
    assert (await client.post("/api/v1/kols/sync", json=weak, headers=BACKEND_HEADERS)).status_code == 200

    async with test_app.state.sessionmaker() as session:
        profile = (await session.execute(select(KOLProfile))).scalar_one()
        attribution = (await session.execute(select(KOLWalletAttribution))).scalar_one()
        assert profile.avatar_url == "https://example.com/avatar.png"
        assert profile.telegram_url == "https://t.me/test_kol"
        assert profile.confidence == 100
        assert profile.verified is True
        assert attribution.confidence == 100
        assert attribution.verified is True
        assert set((profile.source_meta or {}).get("sources", [])) == {
            "Next.ID",
            "KOL Quest / KolScan",
        }
        assert attribution.source_count == 2


@pytest.mark.asyncio
async def test_sync_rejects_invalid_wallet_addresses(client, test_app):
    payload = {
        "items": [
            {
                "handle": "invalid_wallet",
                "confidence": 90,
                "wallets": [
                    {"address": "not-solana", "chain": "solana", "confidence": 90},
                    {"address": "0x1234", "chain": "ethereum", "confidence": 90},
                ],
            }
        ],
        "sourceStatus": [],
    }
    response = await client.post("/api/v1/kols/sync", json=payload, headers=BACKEND_HEADERS)
    assert response.status_code == 200, response.text
    async with test_app.state.sessionmaker() as session:
        assert (await session.execute(select(func.count(KOLWalletAttribution.id)))).scalar_one() == 0


@pytest.mark.asyncio
async def test_shared_wallet_event_is_counted_once(client, test_app):
    strong = sync_payload(handle="strong_kol", confidence=100, verified=True)
    weak = sync_payload(
        handle="weak_kol",
        confidence=70,
        verified=False,
        source="KOL Quest / KolScan",
        wallet_confidence=70,
    )
    assert (await client.post("/api/v1/kols/sync", json=strong, headers=BACKEND_HEADERS)).status_code == 200
    assert (await client.post("/api/v1/kols/sync", json=weak, headers=BACKEND_HEADERS)).status_code == 200

    async with test_app.state.sessionmaker() as session:
        wallet = (
            await session.execute(select(Wallet).where(Wallet.wallet_address == SOL_ADDRESS))
        ).scalar_one()
        session.add(
            KOLTradeEvent(
                analytics_wallet_id=wallet.id,
                chain="solana",
                address=wallet.wallet_address,
                tx_signature="shared-wallet-event-signature",
                event_index=1,
                side="buy",
                mint_address=MINT,
                token_symbol="SOL",
                token_name="Wrapped SOL",
                amount=10,
                price_usd=2,
                value_usd=20,
                source="test",
                occurred_at=datetime.now(timezone.utc),
            )
        )
        await session.commit()

    response = await client.get(f"/api/v1/kols/internal/token/{MINT}", headers=KOL_HEADERS)
    assert response.status_code == 200, response.text
    one_hour = response.json()["windows"]["1h"]
    assert one_hour["buyers"] == 1
    assert one_hour["gross_buy_value_usd"] == 20.0
    assert one_hour["net_flow_usd"] == 20.0
    assert one_hour["handles"] == ["strong_kol"]

    feed = await client.get("/api/v1/kols/internal/live-trades?limit=20", headers=KOL_HEADERS)
    assert feed.status_code == 200, feed.text
    assert len(feed.json()["items"]) == 1
    assert feed.json()["items"][0]["eventId"].startswith("kol-event:")
    assert feed.json()["items"][0]["side"] == "buy"
    assert feed.json()["items"][0]["handle"] == "strong_kol"


@pytest.mark.asyncio
async def test_refresh_clears_stale_internal_event_metric(client, test_app):
    assert (
        await client.post(
            "/api/v1/kols/sync",
            json=sync_payload(metrics={}),
            headers=BACKEND_HEADERS,
        )
    ).status_code == 200

    async with test_app.state.sessionmaker() as session:
        attribution = (await session.execute(select(KOLWalletAttribution))).scalar_one()
        stale = KOLWalletMetric(
            wallet_id=attribution.id,
            timeframe_days=1,
            source="internal_kol_events",
            realized_pnl_usd=123,
            win_rate=100,
            wins=4,
            losses=0,
            volume_usd=500,
            trade_count=4,
            calculated_at=datetime.now(timezone.utc),
        )
        session.add(stale)
        await session.commit()

        result = await refresh_kol_metrics(session)
        await session.commit()
        assert result["wallets"] == 1
        refreshed = (
            await session.execute(
                select(KOLWalletMetric).where(
                    KOLWalletMetric.wallet_id == attribution.id,
                    KOLWalletMetric.timeframe_days == 1,
                    KOLWalletMetric.source == "internal_kol_events",
                )
            )
        ).scalar_one()
        assert refreshed.realized_pnl_usd is None
        assert refreshed.win_rate is None
        assert refreshed.wins is None
        assert refreshed.losses is None
        assert refreshed.volume_usd is None
        assert refreshed.trade_count == 0
        assert refreshed.last_trade_at is None


@pytest.mark.asyncio
async def test_advanced_kol_enrichment_fails_open(monkeypatch, test_app):
    async def boom(*_args, **_kwargs):
        raise RuntimeError("kol tables unavailable")

    monkeypatch.setattr(advanced_api, "build_kol_token_intelligence", boom)
    async with test_app.state.sessionmaker() as session:
        result = await advanced_api._safe_kol_intelligence(session, MINT)
        assert result["status"] == "unavailable"
        assert result["ownership_claim"] is False
        # The savepoint absorbs the optional enrichment failure and leaves the
        # surrounding session usable by the base Advanced Intelligence flow.
        assert (await session.execute(select(func.count(KOLProfile.id)))).scalar_one() == 0
