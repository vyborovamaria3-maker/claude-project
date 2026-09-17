from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import func, select

from app.models.analytics import Wallet
from app.models.kol_intelligence import (
    KOLProfile,
    KOLTradeEvent,
    KOLTradeSyncState,
    KOLWalletAttribution,
)
from app.services import kol_trade_ingestion as ingestion

WALLET = "11111111111111111111111111111111"
TOKEN = "BackfillToken11111111111111111111111111111"
WSOL = "So11111111111111111111111111111111111111112"


def _provider_trade(tx: str, amount: float = 10.0) -> dict:
    return {
        "tx": tx,
        "from": {
            "address": WSOL,
            "amount": 0.1,
            "token": {"name": "Wrapped SOL", "symbol": "SOL"},
            "priceUsd": 100.0,
        },
        "to": {
            "address": TOKEN,
            "amount": amount,
            "token": {"name": "Backfill Token", "symbol": "BFT"},
            "priceUsd": 1.0,
        },
        "volume": {"usd": amount},
        "program": "test-dex",
        "time": int(datetime.now(timezone.utc).timestamp() * 1000),
    }


@pytest.mark.asyncio
async def test_cursor_backfill_completes_then_returns_to_latest_polling(monkeypatch, test_app):
    async with test_app.state.sessionmaker() as session:
        wallet = Wallet(wallet_address=WALLET, first_seen_date=datetime.now(timezone.utc), tags=["kol"])
        profile = KOLProfile(twitter_handle="backfill_kol", confidence=95, verified=True)
        session.add_all([wallet, profile])
        await session.flush()
        session.add(
            KOLWalletAttribution(
                kol_id=profile.id,
                analytics_wallet_id=wallet.id,
                address=WALLET,
                chain="solana",
                confidence=95,
                verified=True,
                source_count=1,
            )
        )
        await session.commit()

        cursors: list[str | None] = []

        async def fake_fetch(address: str, *, api_key: str, base_url: str, cursor: str | None = None, timeout_seconds: float = 15.0):
            assert address == WALLET
            assert api_key == "test-key"
            cursors.append(cursor)
            if cursor is None and len(cursors) == 1:
                return {
                    "trades": [_provider_trade("newest")],
                    "nextCursor": "older-page",
                    "hasNextPage": True,
                }
            if cursor == "older-page":
                return {
                    "trades": [_provider_trade("older")],
                    "nextCursor": None,
                    "hasNextPage": False,
                }
            return {
                # Polling latest after the backfill deliberately repeats an already
                # ingested transaction; the ledger must remain idempotent.
                "trades": [_provider_trade("newest")],
                "nextCursor": "ignored-after-backfill",
                "hasNextPage": True,
            }

        monkeypatch.setattr(ingestion, "fetch_solana_tracker_wallet_trades", fake_fetch)

        first = await ingestion.sync_kol_trade_events(session, api_key="test-key", max_wallets=1)
        await session.commit()
        state = (await session.execute(select(KOLTradeSyncState))).scalar_one()
        assert first["events"] == 1
        assert state.next_cursor == "older-page"
        assert state.backfill_complete is False

        second = await ingestion.sync_kol_trade_events(session, api_key="test-key", max_wallets=1)
        await session.commit()
        await session.refresh(state)
        assert second["events"] == 1
        assert state.next_cursor is None
        assert state.backfill_complete is True

        third = await ingestion.sync_kol_trade_events(session, api_key="test-key", max_wallets=1)
        await session.commit()
        await session.refresh(state)
        assert third["events"] == 0
        assert state.backfill_complete is True
        assert state.next_cursor is None
        assert cursors == [None, "older-page", None]
        assert (await session.execute(select(func.count(KOLTradeEvent.id)))).scalar_one() == 2
