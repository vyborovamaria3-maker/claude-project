from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

import httpx
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analytics import Wallet
from app.models.kol_intelligence import (
    KOLSourceSync,
    KOLTradeEvent,
    KOLTradeSyncState,
    KOLWalletAttribution,
)

_SOURCE = "solana_tracker_trades"
_DEFAULT_BASE_URL = "https://data.solanatracker.io"
_BASE_SYMBOLS = {"SOL", "WSOL", "USDC", "USDT"}
_BASE_MINTS = {
    "So11111111111111111111111111111111111111112",  # wrapped SOL
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _safe_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if parsed != parsed or parsed in {float("inf"), float("-inf")}:
        return None
    return parsed


def _event_time(value: Any) -> datetime | None:
    parsed = _safe_float(value)
    if parsed is None or parsed <= 0:
        return None
    # Solana Tracker currently documents milliseconds, but tolerate seconds so
    # a provider-side representation change does not create year-50000 rows.
    seconds = parsed / 1000.0 if parsed > 10_000_000_000 else parsed
    try:
        return datetime.fromtimestamp(seconds, tz=timezone.utc)
    except (OSError, OverflowError, ValueError):
        return None


def _asset(raw: Any) -> dict[str, Any]:
    return raw if isinstance(raw, dict) else {}


def _is_base_asset(asset: dict[str, Any]) -> bool:
    mint = str(asset.get("address") or "").strip()
    token = asset.get("token") if isinstance(asset.get("token"), dict) else {}
    symbol = str(token.get("symbol") or "").strip().upper()
    return mint in _BASE_MINTS or symbol in _BASE_SYMBOLS


def _normalized_leg(
    *,
    wallet_id: int,
    wallet_address: str,
    tx_signature: str,
    event_index: int,
    side: str,
    asset: dict[str, Any],
    counterparty: dict[str, Any],
    occurred_at: datetime,
    program: str | None,
    fallback_value_usd: float | None,
    raw_payload: dict[str, Any],
) -> dict[str, Any] | None:
    mint = str(asset.get("address") or "").strip()
    if not mint:
        return None
    amount = _safe_float(asset.get("amount"))
    if amount is None or amount <= 0:
        return None
    token = asset.get("token") if isinstance(asset.get("token"), dict) else {}
    price_usd = _safe_float(asset.get("priceUsd"))
    value_usd = amount * price_usd if price_usd is not None and price_usd >= 0 else fallback_value_usd
    counterparty_amount = _safe_float(counterparty.get("amount"))
    return {
        "analytics_wallet_id": wallet_id,
        "chain": "solana",
        "address": wallet_address,
        "tx_signature": tx_signature,
        "event_index": event_index,
        "side": side,
        "mint_address": mint,
        "token_symbol": str(token.get("symbol") or "").strip() or None,
        "token_name": str(token.get("name") or "").strip() or None,
        "amount": amount,
        "price_usd": price_usd,
        "value_usd": value_usd,
        "counterparty_mint": str(counterparty.get("address") or "").strip() or None,
        "counterparty_amount": counterparty_amount,
        "program": program,
        "source": _SOURCE,
        "occurred_at": occurred_at,
        "raw_payload": raw_payload,
    }


def normalize_solana_tracker_trade(
    *,
    wallet_id: int,
    wallet_address: str,
    trade: dict[str, Any],
) -> list[dict[str, Any]]:
    """Convert one provider swap into zero, one or two asset-side events.

    SOL/stable -> token is a buy, token -> SOL/stable is a sell. Token-to-token
    swaps intentionally produce both a sell and a buy leg, preserving the actual
    event semantics instead of compressing them into a position model.
    """
    tx_signature = str(trade.get("tx") or "").strip()
    occurred_at = _event_time(trade.get("time"))
    if not tx_signature or occurred_at is None:
        return []

    from_asset = _asset(trade.get("from"))
    to_asset = _asset(trade.get("to"))
    if not from_asset or not to_asset:
        return []

    volume = trade.get("volume") if isinstance(trade.get("volume"), dict) else {}
    fallback_value_usd = _safe_float(volume.get("usd"))
    program = str(trade.get("program") or "").strip() or None
    from_is_base = _is_base_asset(from_asset)
    to_is_base = _is_base_asset(to_asset)
    legs: list[dict[str, Any]] = []

    if not from_is_base:
        sell = _normalized_leg(
            wallet_id=wallet_id,
            wallet_address=wallet_address,
            tx_signature=tx_signature,
            event_index=0,
            side="sell",
            asset=from_asset,
            counterparty=to_asset,
            occurred_at=occurred_at,
            program=program,
            fallback_value_usd=fallback_value_usd,
            raw_payload=trade,
        )
        if sell is not None:
            legs.append(sell)

    if not to_is_base:
        buy = _normalized_leg(
            wallet_id=wallet_id,
            wallet_address=wallet_address,
            tx_signature=tx_signature,
            event_index=1,
            side="buy",
            asset=to_asset,
            counterparty=from_asset,
            occurred_at=occurred_at,
            program=program,
            fallback_value_usd=fallback_value_usd,
            raw_payload=trade,
        )
        if buy is not None:
            legs.append(buy)

    return legs


async def fetch_solana_tracker_wallet_trades(
    address: str,
    *,
    api_key: str,
    base_url: str = _DEFAULT_BASE_URL,
    timeout_seconds: float = 15.0,
) -> list[dict[str, Any]]:
    url = f"{base_url.rstrip('/')}/wallet/{quote(address, safe='')}/trades"
    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        response = await client.get(url, headers={"x-api-key": api_key, "accept": "application/json"})
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, dict):
        return []
    trades = payload.get("trades")
    return [item for item in trades if isinstance(item, dict)] if isinstance(trades, list) else []


async def _source_sync(session: AsyncSession) -> KOLSourceSync:
    row = (
        await session.execute(select(KOLSourceSync).where(KOLSourceSync.source == _SOURCE).limit(1))
    ).scalar_one_or_none()
    if row is None:
        row = KOLSourceSync(source=_SOURCE, status="unknown", records_seen=0)
        session.add(row)
        await session.flush()
    return row


async def _sync_state(session: AsyncSession, wallet_id: int) -> KOLTradeSyncState:
    row = (
        await session.execute(
            select(KOLTradeSyncState)
            .where(KOLTradeSyncState.analytics_wallet_id == wallet_id)
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is None:
        row = KOLTradeSyncState(analytics_wallet_id=wallet_id, source=_SOURCE, status="pending")
        session.add(row)
        await session.flush()
    return row


async def _wallet_batch(session: AsyncSession, limit: int) -> list[Wallet]:
    # One blockchain wallet may be attributed to several profiles. Fetch it once,
    # prioritising never-synced/oldest-synced wallets and then stronger attribution.
    rows = (
        await session.execute(
            select(Wallet, func.max(KOLWalletAttribution.confidence).label("max_confidence"))
            .join(
                KOLWalletAttribution,
                KOLWalletAttribution.analytics_wallet_id == Wallet.id,
            )
            .outerjoin(
                KOLTradeSyncState,
                KOLTradeSyncState.analytics_wallet_id == Wallet.id,
            )
            .where(
                KOLWalletAttribution.chain == "solana",
                KOLWalletAttribution.analytics_wallet_id.is_not(None),
                KOLWalletAttribution.confidence >= 50,
            )
            .group_by(Wallet.id, KOLTradeSyncState.last_attempt_at)
            .order_by(
                case((KOLTradeSyncState.last_attempt_at.is_(None), 0), else_=1).asc(),
                KOLTradeSyncState.last_attempt_at.asc(),
                func.max(KOLWalletAttribution.confidence).desc(),
                Wallet.id.asc(),
            )
            .limit(limit)
        )
    ).all()
    return [wallet for wallet, _confidence in rows]


async def sync_kol_trade_events(
    session: AsyncSession,
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    max_wallets: int | None = None,
) -> dict[str, int | str]:
    source = await _source_sync(session)
    key = (api_key if api_key is not None else os.getenv("SOLANA_TRACKER_API_KEY", "")).strip()
    resolved_base_url = (base_url or os.getenv("SOLANA_TRACKER_API_BASE", _DEFAULT_BASE_URL)).strip() or _DEFAULT_BASE_URL
    if max_wallets is None:
        try:
            max_wallets = int(os.getenv("KOL_TRADE_SYNC_WALLETS_PER_RUN", "1"))
        except ValueError:
            max_wallets = 1
    max_wallets = max(1, min(25, int(max_wallets)))

    if not key:
        source.status = "disabled"
        source.detail = "SOLANA_TRACKER_API_KEY is not configured; KOL trade ingestion is disabled"
        source.updated_at = utcnow()
        return {"wallets": 0, "events": 0, "failures": 0, "status": "disabled"}

    wallets = await _wallet_batch(session, max_wallets)
    now = utcnow()
    inserted = 0
    failures = 0
    seen_provider_rows = 0

    for wallet in wallets:
        state = await _sync_state(session, wallet.id)
        state.last_attempt_at = now
        state.updated_at = now
        try:
            provider_rows = await fetch_solana_tracker_wallet_trades(
                wallet.wallet_address,
                api_key=key,
                base_url=resolved_base_url,
            )
            seen_provider_rows += len(provider_rows)
            normalized: list[dict[str, Any]] = []
            for provider_trade in provider_rows:
                normalized.extend(
                    normalize_solana_tracker_trade(
                        wallet_id=wallet.id,
                        wallet_address=wallet.wallet_address,
                        trade=provider_trade,
                    )
                )

            signatures = {item["tx_signature"] for item in normalized}
            existing: set[tuple[str, int]] = set()
            if signatures:
                existing = {
                    (str(signature), int(event_index))
                    for signature, event_index in (
                        await session.execute(
                            select(KOLTradeEvent.tx_signature, KOLTradeEvent.event_index).where(
                                KOLTradeEvent.analytics_wallet_id == wallet.id,
                                KOLTradeEvent.tx_signature.in_(signatures),
                            )
                        )
                    ).all()
                }

            dedupe: set[tuple[str, int]] = set()
            wallet_inserted = 0
            for item in normalized:
                key_tuple = (str(item["tx_signature"]), int(item["event_index"]))
                if key_tuple in existing or key_tuple in dedupe:
                    continue
                dedupe.add(key_tuple)
                session.add(KOLTradeEvent(**item))
                wallet_inserted += 1
            if wallet_inserted:
                await session.flush()
            inserted += wallet_inserted
            state.status = "ok"
            state.events_seen = len(normalized)
            state.last_success_at = now
            state.detail = f"providerTrades={len(provider_rows)} normalizedEvents={len(normalized)} inserted={wallet_inserted}"
        except Exception as exc:  # provider failures must not block rotation to other wallets
            failures += 1
            state.status = "error"
            state.last_error_at = now
            state.detail = str(exc)[:1000]

    source.records_seen = seen_provider_rows
    source.updated_at = now
    if failures and failures == len(wallets):
        source.status = "error"
        source.last_error_at = now
        source.detail = f"all {failures} wallet sync(s) failed"
    elif failures:
        source.status = "partial"
        source.last_success_at = now
        source.last_error_at = now
        source.detail = f"wallets={len(wallets)} failures={failures} insertedEvents={inserted}"
    else:
        source.status = "ok"
        source.last_success_at = now
        source.detail = f"wallets={len(wallets)} providerTrades={seen_provider_rows} insertedEvents={inserted}"

    return {
        "wallets": len(wallets),
        "events": inserted,
        "failures": failures,
        "status": source.status,
    }
