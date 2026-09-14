from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.analytics import Token, Wallet, WalletTrade
from app.models.kol_intelligence import KOLProfile, KOLWalletAttribution
from app.services.kol_intelligence import (
    build_kol_token_intelligence,
    related_wallet_candidates,
)
from app.services.telegram_parser import is_solana_address

router = APIRouter()


def _require_backend_key(request: Request, supplied: str | None) -> None:
    expected = request.app.state.settings.backend_api_key
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="BACKEND_API_KEY is not configured",
        )
    if not supplied or not hmac.compare_digest(supplied, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid backend API key",
        )


def _clean_handle(value: str) -> str:
    handle = value.strip().lstrip("@").lower()
    if not handle or len(handle) > 64 or not all(char.isalnum() or char == "_" for char in handle):
        raise HTTPException(status_code=400, detail="Invalid X handle")
    return handle


@router.get("/internal/token/{mint_address}")
async def internal_token_kol_intelligence(
    mint_address: str,
    request: Request,
    session: AsyncSession = Depends(get_db),
    x_backend_api_key: str | None = Header(default=None, alias="X-Backend-API-Key"),
) -> dict:
    _require_backend_key(request, x_backend_api_key)
    if not is_solana_address(mint_address):
        raise HTTPException(status_code=400, detail="Invalid Solana mint address")
    return await build_kol_token_intelligence(session, mint_address)


@router.get("/internal/related/{handle}")
async def internal_related_wallets(
    handle: str,
    request: Request,
    limit: int = Query(default=20, ge=1, le=100),
    session: AsyncSession = Depends(get_db),
    x_backend_api_key: str | None = Header(default=None, alias="X-Backend-API-Key"),
) -> dict:
    _require_backend_key(request, x_backend_api_key)
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


@router.get("/internal/live-trades")
async def internal_live_trades(
    request: Request,
    limit: int = Query(default=50, ge=1, le=200),
    session: AsyncSession = Depends(get_db),
    x_backend_api_key: str | None = Header(default=None, alias="X-Backend-API-Key"),
) -> dict:
    _require_backend_key(request, x_backend_api_key)
    rows = list(
        (
            await session.execute(
                select(WalletTrade, Token, Wallet, KOLWalletAttribution, KOLProfile)
                .join(Token, Token.id == WalletTrade.token_id)
                .join(Wallet, Wallet.id == WalletTrade.wallet_id)
                .join(
                    KOLWalletAttribution,
                    KOLWalletAttribution.analytics_wallet_id == Wallet.id,
                )
                .join(KOLProfile, KOLProfile.id == KOLWalletAttribution.kol_id)
                .where(KOLWalletAttribution.confidence >= 50)
                .order_by(
                    func.coalesce(WalletTrade.sell_timestamp, WalletTrade.buy_timestamp).desc()
                )
                .limit(limit)
            )
        ).all()
    )

    events: list[dict] = []
    for trade, token, wallet, attribution, profile in rows:
        common = {
            "handle": profile.twitter_handle,
            "name": profile.display_name,
            "profileConfidence": profile.confidence,
            "walletConfidence": attribution.confidence,
            "verified": attribution.verified,
            "wallet": wallet.wallet_address,
            "mint": token.mint_address,
            "symbol": token.symbol,
            "tokenName": token.name,
        }
        if trade.buy_timestamp:
            events.append(
                {
                    **common,
                    "side": "buy",
                    "timestamp": trade.buy_timestamp.isoformat(),
                    "amount": trade.amount_buy,
                    "priceUsd": trade.avg_buy_price,
                    "valueUsd": (
                        float(trade.amount_buy) * float(trade.avg_buy_price)
                        if trade.avg_buy_price is not None
                        else None
                    ),
                }
            )
        if trade.sell_timestamp:
            events.append(
                {
                    **common,
                    "side": "sell",
                    "timestamp": trade.sell_timestamp.isoformat(),
                    "amount": trade.amount_sold,
                    "priceUsd": trade.avg_sell_price,
                    "valueUsd": (
                        float(trade.amount_sold) * float(trade.avg_sell_price)
                        if trade.avg_sell_price is not None
                        else None
                    ),
                    "realizedProfitUsd": trade.realized_profit_usd,
                }
            )

    events.sort(key=lambda item: item["timestamp"], reverse=True)
    return {"items": events[:limit], "total": min(len(events), limit)}
