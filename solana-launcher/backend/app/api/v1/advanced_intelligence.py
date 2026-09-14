from __future__ import annotations

import hmac
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_subscriber
from app.core.config import get_settings
from app.db.session import get_db
from app.models.advanced_intelligence import (
    CampaignFingerprint,
    IntelligenceHypothesisState,
    IntelligenceOutcome,
)
from app.models.intelligence_memory import IntelligenceSnapshot
from app.services.advanced_intelligence import build_advanced_intelligence_report
from app.services.advanced_intelligence_enrichment import enrich_advanced_report
from app.services.advanced_intelligence_persistence import (
    persist_advanced_intelligence_state,
)
from app.services.intelligence_outcomes import persist_outcome_values
from app.services.kol_intelligence import build_kol_token_intelligence
from app.services.telegram_parser import is_solana_address

router = APIRouter()
logger = logging.getLogger(__name__)


class AdvancedReportRequest(BaseModel):
    snapshot: dict
    ai_result: dict | None = None
    persist: bool = True
    enrich: bool = True
    role: str = Field(default="analyst", pattern="^(analyst|critic)$")


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


async def _safe_kol_intelligence(session: AsyncSession, mint: str) -> dict:
    try:
        async with session.begin_nested():
            return await build_kol_token_intelligence(session, mint)
    except Exception:
        logger.exception("Optional KOL intelligence enrichment failed for mint %s", mint)
        return {
            "status": "unavailable",
            "mint": mint,
            "signal": "unknown",
            "ownership_claim": False,
            "windows": {},
            "actors": [],
            "attribution_note": (
                "KOL intelligence is temporarily unavailable. "
                "The base advanced-intelligence report remains valid."
            ),
        }


@router.post("/report")
async def advanced_report(
    payload: AdvancedReportRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
    x_backend_api_key: str | None = Header(
        default=None,
        alias="X-Backend-API-Key",
    ),
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
    if payload.role == "analyst" and payload.enrich:
        report = await enrich_advanced_report(
            session,
            get_settings(),
            snapshot=payload.snapshot,
            report=report,
        )
        # Keep the advanced-intelligence 20-layer contract intact: KOL intelligence
        # is optional top-level enrichment and must not break the base report.
        report["kol_intelligence"] = await _safe_kol_intelligence(session, mint)
    if payload.persist:
        await persist_advanced_intelligence_state(
            session,
            snapshot=payload.snapshot,
            report=report,
            ai_result=payload.ai_result,
            role=payload.role,
        )
    return report


@router.post("/outcome")
async def persist_outcome(
    payload: OutcomeRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
    x_backend_api_key: str | None = Header(
        default=None,
        alias="X-Backend-API-Key",
    ),
) -> dict:
    _require_backend_key(request, x_backend_api_key)
    snapshot = await session.get(IntelligenceSnapshot, payload.snapshot_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Snapshot not found")
    result = await persist_outcome_values(
        session,
        snapshot=snapshot,
        horizon_hours=payload.horizon_hours,
        baseline_price_usd=payload.baseline_price_usd,
        max_price_usd=payload.max_price_usd,
        min_price_usd=payload.min_price_usd,
        final_price_usd=payload.final_price_usd,
        payload=payload.payload,
    )
    await session.commit()
    return result


@router.get("/investigation/{mint}")
async def investigation_view(
    mint: str,
    snapshot_limit: int = Query(default=20, ge=1, le=100),
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_subscriber),
) -> dict:
    del current_user
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
    kol_intelligence = await _safe_kol_intelligence(session, mint)
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
        "kol_intelligence": kol_intelligence,
    }
