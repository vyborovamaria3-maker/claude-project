from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.kols_internal import _require_kol_internal_key
from app.db.session import get_db
from app.models.kol_intelligence import (
    KOLSourceSync,
    KOLTradeEvent,
    KOLTradeSyncState,
    KOLWalletAttribution,
)

router = APIRouter()
_SOURCE = "solana_tracker_trades"


@router.get("/internal/trade-coverage")
async def internal_kol_trade_coverage(
    request: Request,
    session: AsyncSession = Depends(get_db),
    x_kol_internal_key: str | None = Header(default=None, alias="X-KOL-Internal-Key"),
) -> dict:
    """Describe actual local event-ledger coverage for attributed Solana wallets.

    Empty local history is explicitly treated as an ingestion/coverage fact, never as
    evidence that a KOL did not trade.
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
            select(func.count(func.distinct(KOLTradeEvent.analytics_wallet_id)))
        )
    ).scalar_one()
    event_rows = (
        await session.execute(select(func.count(func.distinct(KOLTradeEvent.id))))
    ).scalar_one()
    latest_event_at = (
        await session.execute(select(func.max(KOLTradeEvent.occurred_at)))
    ).scalar_one_or_none()
    sync_states = (
        await session.execute(
            select(KOLTradeSyncState.status, func.count(KOLTradeSyncState.id))
            .group_by(KOLTradeSyncState.status)
        )
    ).all()
    source = (
        await session.execute(
            select(KOLSourceSync).where(KOLSourceSync.source == _SOURCE).limit(1)
        )
    ).scalar_one_or_none()

    attributed = int(attributed_wallets or 0)
    covered = int(wallets_with_history or 0)
    rows = int(event_rows or 0)
    ratio = covered / attributed if attributed else 0.0
    provider_status = source.status if source else "unknown"

    if attributed == 0:
        coverage_status = "no_attributed_wallets"
    elif provider_status == "disabled" and covered == 0:
        coverage_status = "ingestion_disabled"
    elif covered == 0:
        coverage_status = "ingestion_missing"
    elif covered < attributed:
        coverage_status = "partial"
    else:
        coverage_status = "covered"

    state_counts = {str(state): int(count or 0) for state, count in sync_states}
    attempted = sum(state_counts.values())

    return {
        "status": coverage_status,
        "provider": {
            "source": _SOURCE,
            "status": provider_status,
            "detail": source.detail if source else None,
            "lastSuccessAt": source.last_success_at.isoformat() if source and source.last_success_at else None,
            "lastErrorAt": source.last_error_at.isoformat() if source and source.last_error_at else None,
        },
        "attributedSolanaWallets": attributed,
        "walletsWithTradeHistory": covered,
        "walletsAttempted": attempted,
        "syncStates": state_counts,
        "eventRows": rows,
        "coverageRatio": round(ratio, 4),
        "latestEventAt": latest_event_at.isoformat() if latest_event_at else None,
        "note": (
            "Coverage measures locally ingested kol_trade_events. Missing local history must not be "
            "interpreted as evidence that a KOL did not trade."
        ),
    }
