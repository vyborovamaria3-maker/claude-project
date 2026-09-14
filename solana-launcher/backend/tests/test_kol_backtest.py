from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import delete, select

from app.models.analytics import Token, TokenMetric, Wallet, WalletTrade
from app.models.kol_intelligence import KOLProfile, KOLWalletAttribution
from app.services.kol_backtest import backtest_kol_signals

KOL_HEADERS = {"X-KOL-Internal-Key": "test-backend-api-key-2026"}


async def _seed_accumulation_case(test_app):
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=36)

    async with test_app.state.sessionmaker() as session:
        token = Token(
            mint_address="So11111111111111111111111111111111111111112",
            name="Backtest Token",
            symbol="BT",
        )
        session.add(token)
        await session.flush()

        for index in range(3):
            wallet = Wallet(
                wallet_address=f"test-wallet-{index}",
                first_seen_date=start - timedelta(days=1),
                tags=["kol"],
            )
            profile = KOLProfile(
                twitter_handle=f"kol_{index}",
                display_name=f"KOL {index}",
                confidence=95,
                verified=True,
            )
            session.add_all([wallet, profile])
            await session.flush()
            attribution = KOLWalletAttribution(
                kol_id=profile.id,
                analytics_wallet_id=wallet.id,
                address=wallet.wallet_address,
                chain="solana",
                confidence=95,
                verified=True,
                source_count=1,
                first_seen_at=start - timedelta(hours=1),
                last_seen_at=now,
            )
            session.add(attribution)
            session.add(
                WalletTrade(
                    wallet_id=wallet.id,
                    token_id=token.id,
                    buy_timestamp=start + timedelta(minutes=index * 10),
                    amount_buy=100,
                    amount_sold=0,
                    avg_buy_price=99.0,
                    avg_sell_price=None,
                    realized_profit_usd=None,
                    still_holding=True,
                )
            )

        # The third buy triggers at start+20m. Baseline must use the last market
        # price BEFORE the trigger, never the deliberately extreme trade average or
        # the +21m future market price.
        session.add_all(
            [
                TokenMetric(token_id=token.id, timestamp=start + timedelta(minutes=15), price_usd=1.0),
                TokenMetric(token_id=token.id, timestamp=start + timedelta(minutes=21), price_usd=10.0),
                TokenMetric(token_id=token.id, timestamp=start + timedelta(hours=1, minutes=30), price_usd=1.1),
                TokenMetric(token_id=token.id, timestamp=start + timedelta(hours=6, minutes=30), price_usd=1.2),
                TokenMetric(token_id=token.id, timestamp=start + timedelta(hours=24, minutes=30), price_usd=1.5),
            ]
        )
        await session.commit()

    return start


@pytest.mark.asyncio
async def test_backtest_requires_scoped_internal_key(client):
    response = await client.get("/api/v1/kols/internal/backtest")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_backtest_builds_signal_without_future_price_leakage(client, test_app):
    start = await _seed_accumulation_case(test_app)

    response = await client.get(
        "/api/v1/kols/internal/backtest?lookbackDays=7&minKols=3&minConfidence=70&costBps=50",
        headers=KOL_HEADERS,
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["coverage"]["rawSignalTriggers"] == 1
    assert payload["coverage"]["signalsSkippedNoBaseline"] == 0
    assert payload["coverage"]["signals"] == 1

    signal = payload["signals"][0]
    assert signal["signalType"] == "accumulation"
    assert signal["kolCount"] == 3
    assert signal["baselineSource"] == "token_metric_before_signal"
    assert signal["baselinePriceUsd"] == 1.0
    assert signal["baselinePriceAt"] == (start + timedelta(minutes=15)).isoformat()
    assert signal["returns"]["1h"]["futurePriceUsd"] == 1.1
    assert signal["returns"]["1h"]["netDirectionalReturnPct"] == 9.5
    assert signal["returns"]["24h"]["netDirectionalReturnPct"] == 49.5
    assert payload["summary"]["byHorizon"]["24h"]["samples"] == 1
    assert payload["summary"]["byHorizon"]["24h"]["winRate"] == 100.0


@pytest.mark.asyncio
async def test_backtest_skips_trigger_without_pre_signal_market_price(test_app):
    await _seed_accumulation_case(test_app)

    async with test_app.state.sessionmaker() as session:
        token = (await session.execute(select(Token))).scalar_one()
        await session.execute(delete(TokenMetric).where(TokenMetric.token_id == token.id))
        # Add only a post-trigger price. Position avg_buy_price remains populated,
        # but must never be used as a backtest entry fallback.
        trade = (await session.execute(select(WalletTrade).order_by(WalletTrade.buy_timestamp.desc()))).scalars().first()
        assert trade is not None
        session.add(
            TokenMetric(
                token_id=token.id,
                timestamp=trade.buy_timestamp + timedelta(minutes=1),
                price_usd=2.0,
            )
        )
        await session.commit()

        payload = await backtest_kol_signals(
            session,
            lookback_days=7,
            min_kols=3,
            min_confidence=70,
        )

    assert payload["coverage"]["rawSignalTriggers"] == 1
    assert payload["coverage"]["signalsSkippedNoBaseline"] == 1
    assert payload["coverage"]["signals"] == 0
    assert payload["signals"] == []


@pytest.mark.asyncio
async def test_backtest_dedupes_multiple_labels_for_one_trade(test_app):
    await _seed_accumulation_case(test_app)

    async with test_app.state.sessionmaker() as session:
        wallet = (
            await session.execute(select(Wallet).where(Wallet.wallet_address == "test-wallet-0"))
        ).scalar_one()
        weak_profile = KOLProfile(
            twitter_handle="weak_duplicate",
            display_name="Weak Duplicate",
            confidence=70,
            verified=False,
        )
        session.add(weak_profile)
        await session.flush()
        session.add(
            KOLWalletAttribution(
                kol_id=weak_profile.id,
                analytics_wallet_id=wallet.id,
                address=wallet.wallet_address,
                chain="solana",
                confidence=70,
                verified=False,
                source_count=1,
                first_seen_at=datetime.now(timezone.utc) - timedelta(days=2),
                last_seen_at=datetime.now(timezone.utc),
            )
        )
        await session.commit()

        payload = await backtest_kol_signals(
            session,
            lookback_days=7,
            min_kols=3,
            min_confidence=70,
            cost_bps=0,
        )

    assert payload["coverage"]["uniqueTrades"] == 3
    assert payload["coverage"]["signals"] == 1
    signal = payload["signals"][0]
    assert signal["kolCount"] == 3
    assert "weak_duplicate" not in signal["handles"]


@pytest.mark.asyncio
async def test_strict_attribution_time_excludes_pre_attribution_trades(test_app):
    start = await _seed_accumulation_case(test_app)

    async with test_app.state.sessionmaker() as session:
        attributions = list((await session.execute(select(KOLWalletAttribution))).scalars().all())
        for attribution in attributions:
            attribution.first_seen_at = start + timedelta(hours=1)
        await session.commit()

        relaxed = await backtest_kol_signals(
            session,
            lookback_days=7,
            min_kols=3,
            strict_attribution_time=False,
        )
        strict = await backtest_kol_signals(
            session,
            lookback_days=7,
            min_kols=3,
            strict_attribution_time=True,
        )

    assert relaxed["coverage"]["signals"] == 1
    assert strict["coverage"]["signals"] == 0
    assert "strict" in strict["methodology"]["attributionBias"]
