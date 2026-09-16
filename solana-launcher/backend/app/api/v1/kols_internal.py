from __future__ import annotations

import hmac
import os
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.kols import KOLSyncRequest, sync_kols
from app.db.session import get_db
from app.models.analytics import Wallet
from app.models.kol_intelligence import (
    KOLProfile,
    KOLTradeEvent,
    KOLWalletAttribution,
    KOLWalletMetric,
)
from app.services.kol_intelligence import (
    build_kol_token_intelligence,
    related_wallet_candidates,
)
from app.services.kol_metrics import refresh_kol_metrics
from app.services.kol_trade_ingestion import sync_kol_trade_events
from app.services.telegram_parser import is_solana_address

router = APIRouter()


class KOLMetricsLookupRequest(BaseModel):
    addresses: list[str] = Field(default_factory=list, max_length=500)


def _require_kol_internal_key(request: Request, supplied: str | None) -> None:
    settings = request.app.state.settings
    expected = os.getenv("KOL_INTERNAL_KEY", "").strip()
    is_production = settings.environment.strip().lower() in {"production", "prod"}
    backend_key = settings.backend_api_key.strip()

    if not expected and not is_production:
        # Keep local/test startup ergonomic while production requires a distinct
        # scoped credential through KOL_INTERNAL_KEY.
        expected = backend_key

    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="KOL_INTERNAL_KEY is not configured",
        )
    if is_production and len(expected) < 32:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="KOL_INTERNAL_KEY must be at least 32 characters in production",
        )
    if is_production and backend_key and hmac.compare_digest(expected, backend_key):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="KOL_INTERNAL_KEY must be different from BACKEND_API_KEY",
        )
    if not supplied or not hmac.compare_digest(supplied, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid KOL internal key",
        )


def _clean_handle(value: str) -> str:
    handle = value.strip().lstrip("@").lower()
    if not handle or len(handle) > 15 or not all(char.isalnum() or char == "_" for char in handle):
        raise HTTPException(status_code=400, detail="Invalid X handle")
    return handle


def _attribution_rank(
    attribution: KOLWalletAttribution,
    profile: KOLProfile,
) -> tuple[int, float, float, int]:
    return (
        1 if attribution.verified else 0,
        float(attribution.confidence or 0.0),
        float(profile.confidence or 0.0),
        -int(profile.id or 0),
    )


@router.post("/internal/sync")
async def internal_sync_kols(
    payload: KOLSyncRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
    x_kol_internal_key: str | None = Header(default=None, alias="X-KOL-Internal-Key"),
) -> dict[str, Any]:
    _require_kol_internal_key(request, x_kol_internal_key)
    # Delegate to the existing sync implementation with the backend-only master key.
    # The public-facing Next service never receives that master credential.
    return await sync_kols(
        payload,
        request,
        session,
        request.app.state.settings.backend_api_key,
    )


@router.post("/internal/sync-trades")
async def internal_sync_trade_events(
    request: Request,
    wallets: int = Query(default=1, ge=1, le=5),
    session: AsyncSession = Depends(get_db),
    x_kol_internal_key: str | None = Header(default=None, alias="X-KOL-Internal-Key"),
) -> dict[str, Any]:
    """Run a small provider sync immediately for diagnostics/manual refresh.

    Celery Beat remains the normal ingestion path. This endpoint is intentionally
    scoped and capped so a browser-side caller can never burn an unbounded provider
    quota even if the internal route is invoked repeatedly during testing.
    """
    _require_kol_internal_key(request, x_kol_internal_key)
    try:
        ingestion = await sync_kol_trade_events(session, max_wallets=wallets)
        metrics = await refresh_kol_metrics(session)
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    return {"ingestion": ingestion, "metrics": metrics}


@router.get("/internal/token/{mint_address}")
async def internal_token_kol_intelligence(
    mint_address: str,
    request: Request,
    session: AsyncSession = Depends(get_db),
    x_kol_internal_key: str | None = Header(default=None, alias="X-KOL-Internal-Key"),
) -> dict:
    _require_kol_internal_key(request, x_kol_internal_key)
    if not is_solana_address(mint_address):
        raise HTTPException(status_code=400, detail="Invalid Solana mint address")
    return await build_kol_token_intelligence(session, mint_address)


@router.get("/internal/related/{handle}")
async def internal_related_wallets(
    handle: str,
    request: Request,
    limit: int = Query(default=20, ge=1, le=100),
    session: AsyncSession = Depends(get_db),
    x_kol_internal_key: str | None = Header(default=None, alias="X-KOL-Internal-Key"),
) -> dict:
    _require_kol_internal_key(request, x_kol_internal_key)
    normalized = _clean_handle(handle)
    wallets = list(
        (
            await session.execute(
                select(KOLWalletAttribution)
                .join(KOLProfile, KOLProfile.id == KOLWalletAttribution.kol_id)
                .where(
                    KOLProfile.twitter_handle == normalized,
                    KOLWalletAttribution.chain == "solana",
                )
                .order_by(KOLWalletAttribution.confidence.desc())
            )
        ).scalars().all()
    )
    if not wallets:
        return {
            "handle": normalized,
            "items": [],
            "classification": "possible_related_wallets",
            "ownershipClaim": False,
        }

    items: list[dict] = []
    seen: set[str] = {wallet.address for wallet in wallets}
    for wallet in wallets:
        for candidate in await related_wallet_candidates(session, wallet.address, limit=limit):
            address = str(candidate.get("address") or "")
            if not address or address in seen:
                continue
            seen.add(address)
            items.append({"sourceWallet": wallet.address, **candidate})
            if len(items) >= limit:
                break
        if len(items) >= limit:
            break
    return {
        "handle": normalized,
        "items": items,
        "classification": "possible_related_wallets",
        "ownershipClaim": False,
    }


@router.post("/internal/metrics")
async def internal_kol_metrics(
    payload: KOLMetricsLookupRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
    x_kol_internal_key: str | None = Header(default=None, alias="X-KOL-Internal-Key"),
) -> dict[str, Any]:
    _require_kol_internal_key(request, x_kol_internal_key)
    addresses = list(
        dict.fromkeys(
            address.strip()
            for address in payload.addresses
            if isinstance(address, str) and is_solana_address(address.strip())
        )
    )[:500]
    if not addresses:
        return {"items": []}

    rows = list(
        (
            await session.execute(
                select(KOLWalletAttribution.address, KOLWalletMetric)
                .join(KOLWalletMetric, KOLWalletMetric.wallet_id == KOLWalletAttribution.id)
                .where(
                    KOLWalletAttribution.chain == "solana",
                    KOLWalletAttribution.address.in_(addresses),
                    KOLWalletMetric.source == "internal_kol_events",
                )
            )
        ).all()
    )

    best: dict[tuple[str, int], KOLWalletMetric] = {}
    for address, metric in rows:
        key = (address, metric.timeframe_days)
        existing = best.get(key)
        if existing is None or metric.calculated_at > existing.calculated_at:
            best[key] = metric

    by_address: dict[str, list[dict[str, Any]]] = {address: [] for address in addresses}
    for (address, _days), metric in best.items():
        by_address.setdefault(address, []).append(
            {
                "timeframeDays": metric.timeframe_days,
                "source": metric.source,
                "realizedPnlUsd": metric.realized_pnl_usd,
                "winRate": metric.win_rate,
                "wins": metric.wins,
                "losses": metric.losses,
                "volumeUsd": metric.volume_usd,
                "tradeCount": metric.trade_count,
                "lastTradeAt": metric.last_trade_at.isoformat() if metric.last_trade_at else None,
                "calculatedAt": metric.calculated_at.isoformat() if metric.calculated_at else None,
            }
        )
    return {
        "items": [
            {"address": address, "chain": "solana", "metrics": metrics}
            for address, metrics in by_address.items()
            if metrics
        ]
    }


@router.get("/internal/live-trades")
async def internal_live_trades(
    request: Request,
    limit: int = Query(default=50, ge=1, le=200),
    session: AsyncSession = Depends(get_db),
    x_kol_internal_key: str | None = Header(default=None, alias="X-KOL-Internal-Key"),
) -> dict:
    _require_kol_internal_key(request, x_kol_internal_key)
    raw_rows = list(
        (
            await session.execute(
                select(KOLTradeEvent, Wallet, KOLWalletAttribution, KOLProfile)
                .join(Wallet, Wallet.id == KOLTradeEvent.analytics_wallet_id)
                .join(
                    KOLWalletAttribution,
                    KOLWalletAttribution.analytics_wallet_id == Wallet.id,
                )
                .join(KOLProfile, KOLProfile.id == KOLWalletAttribution.kol_id)
                .where(
                    KOLWalletAttribution.chain == "solana",
                    KOLWalletAttribution.confidence >= 50,
                )
                .order_by(KOLTradeEvent.occurred_at.desc(), KOLTradeEvent.id.desc())
                .limit(min(limit * 4, 800))
            )
        ).all()
    )

    best_by_event: dict[int, tuple[KOLTradeEvent, Wallet, KOLWalletAttribution, KOLProfile]] = {}
    for row in raw_rows:
        event, _wallet, attribution, profile = row
        existing = best_by_event.get(event.id)
        if existing is None or _attribution_rank(attribution, profile) > _attribution_rank(
            existing[2], existing[3]
        ):
            best_by_event[event.id] = row

    events: list[dict[str, Any]] = []
    for event, wallet, attribution, profile in best_by_event.values():
        events.append(
            {
                "eventId": f"kol-event:{event.id}",
                "tradeId": event.id,
                "handle": profile.twitter_handle,
                "name": profile.display_name,
                "profileConfidence": profile.confidence,
                "walletConfidence": attribution.confidence,
                "verified": attribution.verified,
                "wallet": wallet.wallet_address,
                "mint": event.mint_address,
                "symbol": event.token_symbol,
                "tokenName": event.token_name,
                "side": event.side,
                "timestamp": event.occurred_at.isoformat(),
                "amount": event.amount,
                "priceUsd": event.price_usd,
                "valueUsd": event.value_usd,
                "realizedProfitUsd": None,
                "txSignature": event.tx_signature,
                "program": event.program,
                "source": event.source,
            }
        )

    events.sort(key=lambda item: item["timestamp"], reverse=True)
    selected = events[:limit]
    return {"items": selected, "total": len(selected), "source": "kol_trade_events"}
