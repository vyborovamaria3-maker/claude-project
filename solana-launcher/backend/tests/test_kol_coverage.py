from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app.models.analytics import Wallet
from app.models.kol_intelligence import KOLTradeEvent
from app.tests.test_kol_intelligence import KOL_HEADERS, BACKEND_HEADERS, MINT, SOL_ADDRESS, sync_payload


@pytest.mark.asyncio
async def test_trade_coverage_requires_scoped_key(client):
    response = await client.get("/api/v1/kols/internal/trade-coverage")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_trade_coverage_distinguishes_missing_ingestion_from_covered_history(client, test_app):
    synced = await client.post(
        "/api/v1/kols/sync",
        json=sync_payload(),
        headers=BACKEND_HEADERS,
    )
    assert synced.status_code == 200, synced.text

    missing = await client.get("/api/v1/kols/internal/trade-coverage", headers=KOL_HEADERS)
    assert missing.status_code == 200, missing.text
    missing_payload = missing.json()
    assert missing_payload["status"] == "ingestion_missing"
    assert missing_payload["attributedSolanaWallets"] == 1
    assert missing_payload["walletsWithTradeHistory"] == 0
    assert missing_payload["eventRows"] == 0
    assert "must not be interpreted" in missing_payload["note"]

    async with test_app.state.sessionmaker() as session:
        wallet = (
            await session.execute(select(Wallet).where(Wallet.wallet_address == SOL_ADDRESS))
        ).scalar_one()
        session.add(
            KOLTradeEvent(
                analytics_wallet_id=wallet.id,
                chain="solana",
                address=wallet.wallet_address,
                tx_signature="coverage-event",
                event_index=1,
                side="buy",
                mint_address=MINT,
                amount=1,
                price_usd=1,
                value_usd=1,
                source="test",
                occurred_at=datetime.now(timezone.utc),
            )
        )
        await session.commit()

    covered = await client.get("/api/v1/kols/internal/trade-coverage", headers=KOL_HEADERS)
    assert covered.status_code == 200, covered.text
    covered_payload = covered.json()
    assert covered_payload["status"] == "covered"
    assert covered_payload["walletsWithTradeHistory"] == 1
    assert covered_payload["eventRows"] == 1
    assert covered_payload["coverageRatio"] == 1.0
