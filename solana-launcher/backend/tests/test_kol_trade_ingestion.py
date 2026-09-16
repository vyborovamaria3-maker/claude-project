from __future__ import annotations

from datetime import datetime, timezone

from app.models.kol_intelligence import KOLTradeEvent
from app.services.kol_metrics import _fifo_realized
from app.services.kol_trade_ingestion import normalize_solana_tracker_trade

WALLET = "11111111111111111111111111111111"
TOKEN_A = "TokenA111111111111111111111111111111111111"
TOKEN_B = "TokenB111111111111111111111111111111111111"
WSOL = "So11111111111111111111111111111111111111112"


def _asset(address: str, amount: float, symbol: str, price: float | None = None) -> dict:
    payload = {
        "address": address,
        "amount": amount,
        "token": {"name": symbol, "symbol": symbol},
    }
    if price is not None:
        payload["priceUsd"] = price
    return payload


def _trade(from_asset: dict, to_asset: dict, *, tx: str = "sig-1") -> dict:
    return {
        "tx": tx,
        "from": from_asset,
        "to": to_asset,
        "volume": {"usd": 25.0},
        "program": "test-dex",
        "time": int(datetime.now(timezone.utc).timestamp() * 1000),
    }


def test_normalize_base_to_token_as_buy():
    events = normalize_solana_tracker_trade(
        wallet_id=7,
        wallet_address=WALLET,
        trade=_trade(_asset(WSOL, 0.2, "SOL", 125.0), _asset(TOKEN_A, 100, "AAA", 0.25)),
    )
    assert len(events) == 1
    event = events[0]
    assert event["side"] == "buy"
    assert event["event_index"] == 1
    assert event["mint_address"] == TOKEN_A
    assert event["counterparty_mint"] == WSOL
    assert event["amount"] == 100
    assert event["price_usd"] == 0.25
    assert event["value_usd"] == 25.0


def test_normalize_token_to_base_as_sell():
    events = normalize_solana_tracker_trade(
        wallet_id=7,
        wallet_address=WALLET,
        trade=_trade(_asset(TOKEN_A, 100, "AAA", 0.3), _asset(WSOL, 0.24, "SOL", 125.0)),
    )
    assert len(events) == 1
    event = events[0]
    assert event["side"] == "sell"
    assert event["event_index"] == 0
    assert event["mint_address"] == TOKEN_A
    assert event["price_usd"] == 0.3


def test_normalize_token_to_token_preserves_both_legs():
    events = normalize_solana_tracker_trade(
        wallet_id=7,
        wallet_address=WALLET,
        trade=_trade(_asset(TOKEN_A, 10, "AAA", 2.0), _asset(TOKEN_B, 5, "BBB", 4.0)),
    )
    assert [(event["side"], event["event_index"], event["mint_address"]) for event in events] == [
        ("sell", 0, TOKEN_A),
        ("buy", 1, TOKEN_B),
    ]


def test_symbol_spoof_does_not_turn_unknown_mint_into_base_asset():
    events = normalize_solana_tracker_trade(
        wallet_id=7,
        wallet_address=WALLET,
        trade=_trade(
            _asset(TOKEN_A, 10, "USDC", 2.0),
            _asset(WSOL, 0.16, "SOL", 125.0),
            tx="spoof-usdc-symbol",
        ),
    )
    assert len(events) == 1
    assert events[0]["side"] == "sell"
    assert events[0]["mint_address"] == TOKEN_A


def test_normalizer_rejects_trade_without_stable_identity_or_timestamp():
    invalid_tx = _trade(_asset(WSOL, 1, "SOL"), _asset(TOKEN_A, 1, "AAA"))
    invalid_tx["tx"] = ""
    assert normalize_solana_tracker_trade(wallet_id=1, wallet_address=WALLET, trade=invalid_tx) == []

    invalid_time = _trade(_asset(WSOL, 1, "SOL"), _asset(TOKEN_A, 1, "AAA"))
    invalid_time["time"] = "not-a-time"
    assert normalize_solana_tracker_trade(wallet_id=1, wallet_address=WALLET, trade=invalid_time) == []


def _event(event_id: int, side: str, amount: float, price: float | None) -> KOLTradeEvent:
    return KOLTradeEvent(
        id=event_id,
        analytics_wallet_id=1,
        chain="solana",
        address=WALLET,
        tx_signature=f"fifo-{event_id}",
        event_index=1 if side == "buy" else 0,
        side=side,
        mint_address=TOKEN_A,
        amount=amount,
        price_usd=price,
        value_usd=(amount * price if price is not None else None),
        source="test",
        occurred_at=datetime.now(timezone.utc),
    )


def test_fifo_realized_uses_prior_cost_basis():
    realized = _fifo_realized(
        [
            _event(1, "buy", 10, 2.0),
            _event(2, "buy", 10, 4.0),
            _event(3, "sell", 15, 5.0),
        ]
    )
    # 10 * (5-2) + 5 * (5-4) = 35
    assert realized[3] == 35.0


def test_fifo_realized_refuses_partial_or_unpriced_cost_basis():
    partial = _fifo_realized([_event(1, "buy", 2, 1.0), _event(2, "sell", 3, 2.0)])
    assert partial[2] is None

    unpriced = _fifo_realized([_event(3, "buy", 3, None), _event(4, "sell", 3, 2.0)])
    assert unpriced[4] is None
