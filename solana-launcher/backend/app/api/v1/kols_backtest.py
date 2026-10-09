from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.kols_internal import _require_kol_internal_key
from app.db.session import get_db
from app.services.kol_backtest import backtest_kol_signals

router = APIRouter()


@router.get("/internal/backtest")
async def internal_kol_backtest(
    request: Request,
    lookback_days: int = Query(default=90, alias="lookbackDays", ge=7, le=365),
    min_kols: int = Query(default=3, alias="minKols", ge=2, le=20),
    min_confidence: float = Query(default=70.0, alias="minConfidence", ge=0, le=100),
    window_minutes: int = Query(default=60, alias="windowMinutes", ge=15, le=360),
    cooldown_minutes: int = Query(default=60, alias="cooldownMinutes", ge=15, le=1440),
    cost_bps: int = Query(default=50, alias="costBps", ge=0, le=1000),
    max_signals: int = Query(default=300, alias="maxSignals", ge=10, le=1000),
    strict_attribution_time: bool = Query(default=False, alias="strictAttributionTime"),
    session: AsyncSession = Depends(get_db),
    x_kol_internal_key: str | None = Header(default=None, alias="X-KOL-Internal-Key"),
) -> dict:
    _require_kol_internal_key(request, x_kol_internal_key)
    return await backtest_kol_signals(
        session,
        lookback_days=lookback_days,
        min_kols=min_kols,
        min_confidence=min_confidence,
        window_minutes=window_minutes,
        cooldown_minutes=cooldown_minutes,
        cost_bps=cost_bps,
        max_signals=max_signals,
        strict_attribution_time=strict_attribution_time,
    )
