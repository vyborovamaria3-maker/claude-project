from __future__ import annotations

from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app.models.analytics import Wallet
from app.models.kol_intelligence import (
    KOLProfile,
    KOLTradeEvent,
    KOLWalletAttribution,
    KOLWalletMetric,
)
from app.services.kol_metrics import refresh_kol_metrics
from app.services.kol_trade_ingestion import normalize_solana_tracker_trade

WALLET = "11111111111111111111111111111111"
TOKEN_A = "TokenA111111111111111111111111111111111111"
TOKEN_B = "TokenB111111111111111111111111111111111111"
SPOOF_USDC = "SpoofUSDC111111111111111111111111111111111"


def test_symbol_spoof_does_not_turn_arbitrary_token_into_base_asset():
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    rows = normalize_solana_tracker_trade(
        wallet_id=1,
        wallet_address=WALLET,
        trade={
            "tx": "spoofed-symbol-swap",
            "from": {
                "address": SPOOF_USDC,
                "amount": 10,
                "priceUsd": 1,
                "token": {"name": "Definitely Not USDC", "symbol": "USDC"},
            },
            "to": {
                "address": TOKEN_B,
                "amount": 5,
                "priceUsd": 2,
                "token": {"name": "Token B", "symbol": "BBB"},
            },
            "volume": {"usd": 10},
            "program": "test-dex",
            "time": now_ms,
        },
    )

    assert [(row["side"], row["mint_address"]) for row in rows] == [
        ("sell", SPOOF_USDC),
        ("buy", TOKEN_B),
    ]


@pytest.mark.asyncio
async def test_token_to_token_swap_counts_one_wallet_trade_and_one_notional(test_app):
    now = datetime.now(timezone.utc)
    async with test_app.state.sessionmaker() as session:
        wallet = Wallet(wallet_address=WALLET, first_seen_date=now, tags=["kol"])
        profile = KOLProfile(twitter_handle="volume_kol", confidence=95, verified=True)
        session.add_all([wallet, profile])
        await session.flush()
        attribution = KOLWalletAttribution(
            kol_id=profile.id,
            analytics_wallet_id=wallet.id,
            address=WALLET,
            chain="solana",
            confidence=95,
            verified=True,
            source_count=1,
        )
        session.add(attribution)
        await session.flush()

        # One token->token transaction becomes two event legs for token-flow
        # semantics, but wallet-level volume/trade_count must only count the
        # underlying transaction once.
        session.add_all(
            [
                KOLTradeEvent(
                    analytics_wallet_id=wallet.id,
                    chain="solana",
                    address=WALLET,
                    tx_signature="token-to-token-1",
                    event_index=0,
                    side="sell",
                    mint_address=TOKEN_A,
                    amount=10,
                    price_usd=2,
                    value_usd=20,
                    counterparty_mint=TOKEN_B,
                    source="test",
                    occurred_at=now,
                ),
                KOLTradeEvent(
                    analytics_wallet_id=wallet.id,
                    chain="solana",
                    address=WALLET,
                    tx_signature="token-to-token-1",
                    event_index=1,
                    side="buy",
                    mint_address=TOKEN_B,
                    amount=5,
                    price_usd=4,
                    value_usd=20,
                    counterparty_mint=TOKEN_A,
                    source="test",
                    occurred_at=now,
                ),
            ]
        )
        await session.commit()

        result = await refresh_kol_metrics(session)
        await session.commit()
        assert result == {"wallets": 1, "metrics": 3}

        metric = (
            await session.execute(
                select(KOLWalletMetric).where(
                    KOLWalletMetric.wallet_id == attribution.id,
                    KOLWalletMetric.timeframe_days == 1,
                    KOLWalletMetric.source == "internal_kol_events",
                )
            )
        ).scalar_one()
        assert metric.trade_count == 1
        assert metric.volume_usd == 20
        assert (metric.raw_payload or {}).get("event_count") == 2
        assert (metric.raw_payload or {}).get("transaction_count") == 1
