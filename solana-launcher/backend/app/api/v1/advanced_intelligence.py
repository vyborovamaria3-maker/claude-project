from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_subscriber
from app.db.session import get_db
from app.models.advanced_intelligence import (
    CampaignFingerprint,
    IntelligenceHypothesisState,
    IntelligenceOutcome,
)
from app.models.intelligence_memory import IntelligenceSnapshot
from app.services.advanced_intelligence import (
    build_advanced_intelligence_report,
    persist_advanced_intelligence,
)
from app.services.telegram_parser import is_solana_address

router = APIRouter()


class AdvancedReportRequest(BaseModel):
    snapshot: dict
    ai_result: dict | None = None
    persist: bool = True


class OutcomeRequest(BaseModel):
    snapshot_id: str = Field(min_length=1, max_length=160)
    horizon_hours: int = Field(ge=1, le=720)
    baseline_price_usd: float | None = Field(default=None, ge=0)
    max_price_usd: float | None = Field(default=None, ge=0)
    min_price_usd: float | None = Field(default=None, ge=0)
    final_price_usd: float | None = Field(default=None, ge=0)
    payload: dict | None = None


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


@router.post("/report")
async def advanced_report(
    payload: AdvancedReportRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
    x_backend_api_key: str | None = Header(default=None, alias="X-Backend-API-Key"),
) -> dict:
    _require_backend_key(request, x_backend_api_key)
    mint = str(payload.snapshot.get("mint") or "")
    if not is_solana_address(mint):
        raise HTTPException(status_code=400, detail="Invalid snapshot mint")
    report = await build_advanced_intelligence_report(
        session,
        snapshot=payload.snapshot,
        ai_result=payload.ai_result,
    )
    if payload.persist:
        await persist_advanced_intelligence(
            session,
            snapshot=payload.snapshot,
            report=report,
            ai_result=payload.ai_result,
        )
    return report


@router.post("/outcome")
async def persist_outcome(
    payload: OutcomeRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
    x_backend_api_key: str | None = Header(default=None, alias="X-Backend-API-Key"),
) -> dict:
    _require_backend_key(request, x_backend_api_key)
    snapshot = await session.get(IntelligenceSnapshot, payload.snapshot_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    existing = (
        await session.execute(
            select(IntelligenceOutcome).where(
                IntelligenceOutcome.snapshot_id == payload.snapshot_id,
                IntelligenceOutcome.horizon_hours == payload.horizon_hours,
            )
        )
    ).scalar_one_or_none()
    baseline = payload.baseline_price_usd
    max_multiple = (
        payload.max_price_usd / baseline
        if baseline and payload.max_price_usd is not None
        else None
    )
    drawdown = (
        (payload.min_price_usd - baseline) / baseline * 100
        if baseline and payload.min_price_usd is not None
        else None
    )
    if max_multiple is None:
        label = "unknown"
    elif max_multiple >= 5:
        label = "5x_plus"
    elif max_multiple >= 2:
        label = "2x_plus"
    elif drawdown is not None and drawdown <= -80:
        label = "collapse"
    else:
        label = "sub_2x"
    values = {
        "mint_address": snapshot.mint_address,
        "baseline_price_usd": baseline,
        "max_price_usd": payload.max_price_usd,
        "min_price_usd": payload.min_price_usd,
        "final_price_usd": payload.final_price_usd,
        "max_multiple": max_multiple,
        "max_drawdown_pct": drawdown,
        "outcome_label": label,
        "payload": payload.payload,
    }
    if existing is None:
        existing = IntelligenceOutcome(
            snapshot_id=payload.snapshot_id,
            horizon_hours=payload.horizon_hours,
            **values,
        )
        session.add(existing)
    else:
        for key, value in values.items():
            setattr(existing, key, value)
    await session.commit()
    return {
        "snapshot_id": payload.snapshot_id,
        "horizon_hours": payload.horizon_hours,
        "outcome_label": label,
        "max_multiple": max_multiple,
        "max_drawdown_pct": drawdown,
    }


@router.get("/investigation/{mint}")
async def investigation_view(
    mint: str,
    snapshot_limit: int = Query(default=20, ge=1, le=100),
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_subscriber),
) -> dict:
    if not is_solana_address(mint):
        raise HTTPException(status_code=400, detail="Invalid Solana mint address")
    snapshots = list(
        (
            await session.execute(
                select(IntelligenceSnapshot)
                .where(IntelligenceSnapshot.mint_address == mint)
                .order_by(IntelligenceSnapshot.created_at.desc())
                .limit(snapshot_limit)
            )
        ).scalars().all()
    )
    snapshot_ids = [row.snapshot_id for row in snapshots]
    fingerprints = []
    outcomes = []
    if snapshot_ids:
        fingerprints = list(
            (
                await session.execute(
                    select(CampaignFingerprint).where(
                        CampaignFingerprint.snapshot_id.in_(snapshot_ids)
                    )
                )
            ).scalars().all()
        )
        outcomes = list(
            (
                await session.execute(
                    select(IntelligenceOutcome).where(
                        IntelligenceOutcome.snapshot_id.in_(snapshot_ids)
                    )
                )
            ).scalars().all()
        )
    hypothesis_rows = list(
        (
            await session.execute(
                select(IntelligenceHypothesisState)
                .where(IntelligenceHypothesisState.mint_address == mint)
                .order_by(IntelligenceHypothesisState.updated_at.desc())
                .limit(100)
            )
        ).scalars().all()
    )
    return {
        "mint": mint,
        "snapshots": [
            {
                "snapshot_id": row.snapshot_id,
                "created_at": row.created_at.isoformat(),
                "confidence": row.overall_confidence,
                "feature_count": row.feature_count,
                "graph_version": row.graph_version,
            }
            for row in snapshots
        ],
        "campaign_fingerprints": [
            {
                "snapshot_id": row.snapshot_id,
                "hash": row.fingerprint_hash,
                "vector": row.vector,
                "actors": row.actors,
                "narratives": row.narratives,
            }
            for row in fingerprints
        ],
        "hypotheses": [
            {
                "key": row.hypothesis_key,
                "type": row.hypothesis_type,
                "source": row.source_key,
                "target": row.target_key,
                "status": row.status,
                "confidence": row.confidence,
                "support_count": row.support_count,
                "contradiction_count": row.contradiction_count,
                "updated_at": row.updated_at.isoformat(),
            }
            for row in hypothesis_rows
        ],
        "outcomes": [
            {
                "snapshot_id": row.snapshot_id,
                "horizon_hours": row.horizon_hours,
                "label": row.outcome_label,
                "max_multiple": row.max_multiple,
                "max_drawdown_pct": row.max_drawdown_pct,
            }
            for row in outcomes
        ],
    }
