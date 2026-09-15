from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.kols_internal import _require_kol_internal_key
from app.db.session import get_db
from app.models.analytics import WalletTrade
from app.models.kol_intelligence import KOLWalletAttribution

router = APIRouter()


@router.get("/internal/trade-coverage")
async def internal_kol_trade_coverage(
    request: Request,
    session: AsyncSession = Depends(get_db),
    x_kol_internal_key: str | None = Header(default=None, alias="X-KOL-Internal-Key"),
) -> dict:
    """Describe how much of the attributed Solana KOL universe has local trade history.

    This endpoint intentionally does not pretend that an empty wallet_trades table
    means a KOL was inactive. It lets the frontend distinguish missing ingestion
    from genuine no-activity results.
    """
    _require_kol_internal_key(request, x_kol_internal_key)

    attributed_wallets = (
        await session.execute(
            select(func.count(func.distinct(KOLWalletAttribution.analytics_wallet_id))).where(
                KOLWalletAttribution.chain == "solana",
                KOLWalletAttribution.analytics_wallet_id.is_not(None),
            )
        )
    ).scalar_one()

    wallets_with_history = (
        await session.execute(
            select(func.count(func.distinct(WalletTrade.wallet_id)))
            .join(
                KOLWalletAttribution,
                KOLWalletAttribution.analytics_wallet_id == WalletTrade.wallet_id,
            )
            .where(KOLWalletAttribution.chain == "solana")
        )
    ).scalar_one()

    trade_rows = (
        await session.execute(
            select(func.count(func.distinct(WalletTrade.id)))
            .join(
                KOLWalletAttribution,
                KOLWalletAttribution.analytics_wallet_id == WalletTrade.wallet_id,
            )
            .where(KOLWalletAttribution.chain == "solana")
        )
    ).scalar_one()

    latest_trade_at = (
        await session.execute(
            select(func.max(func.coalesce(WalletTrade.sell_timestamp, WalletTrade.buy_timestamp)))
            .join(
                KOLWalletAttribution,
                KOLWalletAttribution.analytics_wallet_id == WalletTrade.wallet_id,
            )
            .where(KOLWalletAttribution.chain == "solana")
        )
    ).scalar_one_or_none()

    attributed = int(attributed_wallets or 0)
    covered = int(wallets_with_history or 0)
    rows = int(trade_rows or 0)
    ratio = covered / attributed if attributed else 0.0

    if attributed == 0:
        status = "no_attributed_wallets"
    elif covered == 0:
        status = "ingestion_missing"
    elif covered < attributed:
        status = "partial"
    else:
        status = "covered"

    return {
        "status": status,
        "attributedSolanaWallets": attributed,
        "walletsWithTradeHistory": covered,
        "tradeRows": rows,
        "coverageRatio": round(ratio, 4),
        "latestTradeAt": latest_trade_at.isoformat() if latest_trade_at else None,
        "note": (
            "Coverage measures locally ingested wallet_trades. Missing history must not be "
            "interpreted as evidence that a KOL did not trade."
        ),
    }
