from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app.models.analytics import Wallet
from app.models.kol_intelligence import KOLTradeEvent

BACKEND_HEADERS = {"X-Backend-API-Key": "test-backend-api-key-2026"}
KOL_HEADERS = {"X-KOL-Internal-Key": "test-backend-api-key-2026"}
SOL_ADDRESS = "11111111111111111111111111111111"
MINT = "So11111111111111111111111111111111111111112"


def _sync_payload() -> dict:
    return {
        "items": [
            {
                "handle": "coverage_kol",
                "name": "Coverage KOL",
                "confidence": 100,
                "verified": True,
                "sources": ["Next.ID"],
                "wallets": [
                    {
                        "address": SOL_ADDRESS,
                        "chain": "solana",
                        "confidence": 100,
                        "verified": True,
                        "evidence": [
                            {
                                "source": "Next.ID",
                                "kind": "signed_proof",
                                "confidence": 100,
                                "verified": True,
                                "detail": "coverage fixture",
                            }
                        ],
                        "metrics": {},
                    }
                ],
            }
        ],
        "sourceStatus": [{"source": "Next.ID", "ok": True, "detail": "test"}],
    }


@pytest.mark.asyncio
async def test_trade_coverage_requires_scoped_key(client):
    response = await client.get("/api/v1/kols/internal/trade-coverage")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_trade_coverage_reports_disabled_provider_before_first_worker_run(client, monkeypatch):
    monkeypatch.delenv("SOLANA_TRACKER_API_KEY", raising=False)
    synced = await client.post(
        "/api/v1/kols/sync",
        json=_sync_payload(),
        headers=BACKEND_HEADERS,
    )
    assert synced.status_code == 200, synced.text

    response = await client.get("/api/v1/kols/internal/trade-coverage", headers=KOL_HEADERS)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "ingestion_disabled"
    assert payload["provider"]["configured"] is False
    assert payload["walletsWithTradeHistory"] == 0


@pytest.mark.asyncio
async def test_trade_coverage_distinguishes_missing_ingestion_from_covered_history(client, test_app, monkeypatch):
    monkeypatch.setenv("SOLANA_TRACKER_API_KEY", "configured-test-key")
    synced = await client.post(
        "/api/v1/kols/sync",
        json=_sync_payload(),
        headers=BACKEND_HEADERS,
    )
    assert synced.status_code == 200, synced.text

    missing = await client.get("/api/v1/kols/internal/trade-coverage", headers=KOL_HEADERS)
    assert missing.status_code == 200, missing.text
    missing_payload = missing.json()
    assert missing_payload["status"] == "ingestion_missing"
    assert missing_payload["provider"]["configured"] is True
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
