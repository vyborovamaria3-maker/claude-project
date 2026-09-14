from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_kol_sync_requires_backend_key(client):
    response = await client.post("/api/v1/kols/sync", json={"items": [], "sourceStatus": []})
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_kol_sync_is_idempotent(client):
    payload = {
        "items": [
            {
                "handle": "test_kol",
                "name": "Test KOL",
                "twitterUrl": "https://x.com/test_kol",
                "confidence": 100,
                "verified": True,
                "sources": ["Next.ID"],
                "wallets": [
                    {
                        "address": "11111111111111111111111111111111",
                        "chain": "solana",
                        "confidence": 100,
                        "verified": True,
                        "evidence": [
                            {
                                "source": "Next.ID",
                                "kind": "signed_proof",
                                "confidence": 100,
                                "verified": True,
                                "detail": "test proof",
                                "url": "https://next.id/",
                            }
                        ],
                        "metrics": {"pnl7dSol": 1.25, "wins": 3, "losses": 1, "winRate": 75},
                    }
                ],
            }
        ],
        "sourceStatus": [{"source": "Next.ID", "ok": True, "detail": "test"}],
    }
    headers = {"X-Backend-API-Key": "test-backend-api-key-2026"}

    first = await client.post("/api/v1/kols/sync", json=payload, headers=headers)
    second = await client.post("/api/v1/kols/sync", json=payload, headers=headers)

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["profiles"] == 1
    assert first.json()["wallets"] == 1
    assert second.json()["profiles"] == 1
    assert second.json()["wallets"] == 1
