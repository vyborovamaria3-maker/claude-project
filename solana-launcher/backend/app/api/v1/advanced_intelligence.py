from __future__ import annotations

import hmac
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
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
from app.services.analysis_jobs import (
    analysis_request_fingerprint,
    create_analysis_job,
    fail_analysis_job,
    read_analysis_job,
    read_cached_analysis,
    release_analysis_reservation,
    reserve_analysis_job,
)
from app.services.intelligence_outcomes import persist_outcome_values
from app.services.observability import ANALYSIS_CACHE_REQUESTS, ANALYSIS_STAGE_RUNTIME
from app.services.telegram_parser import is_solana_address
from app.tasks.advanced_intelligence import enrich_report

router = APIRouter()


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


def _validate_snapshot_mint(payload: AdvancedReportRequest) -> str:
    mint = str(payload.snapshot.get("mint") or "")
    if not is_solana_address(mint):
        raise HTTPException(status_code=400, detail="Invalid snapshot mint")
    return mint


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
    """Compatibility path that performs the complete analysis synchronously."""
    _require_backend_key(request, x_backend_api_key)
    _validate_snapshot_mint(payload)

    with ANALYSIS_STAGE_RUNTIME.labels(stage="synchronous_report").time():
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
        if payload.persist:
            await persist_advanced_intelligence_state(
                session,
                snapshot=payload.snapshot,
                report=report,
                ai_result=payload.ai_result,
                role=payload.role,
            )
    return report


@router.post("/report/async")
async def advanced_report_async(
    payload: AdvancedReportRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_db),
    x_backend_api_key: str | None = Header(
        default=None,
        alias="X-Backend-API-Key",
    ),
) -> dict:
    """Return deterministic analysis quickly and move slow enrichment off-request.

    Identical requests are single-flighted through Redis: callers reuse an active
    job, and recently completed reports are returned without repeating RPC or DB
    enrichment work.
    """
    _require_backend_key(request, x_backend_api_key)
    mint = _validate_snapshot_mint(payload)
    fingerprint = analysis_request_fingerprint(
        snapshot=payload.snapshot,
        ai_result=payload.ai_result,
        role=payload.role,
        enrich=payload.enrich,
        persist=payload.persist,
    )

    try:
        cached = await read_cached_analysis(fingerprint)
        if cached is not None:
            ANALYSIS_CACHE_REQUESTS.labels(
                layer="advanced_report",
                result="hit",
            ).inc()
            response.status_code = status.HTTP_200_OK
            return {
                "status": "completed",
                "cached": True,
                "snapshot_id": payload.snapshot.get("snapshotId"),
                "mint": mint,
                "report": cached,
            }
        ANALYSIS_CACHE_REQUESTS.labels(
            layer="advanced_report",
            result="miss",
        ).inc()

        job_id = uuid4().hex
        active_job_id = await reserve_analysis_job(fingerprint, job_id)
        if active_job_id:
            active_state = await read_analysis_job(active_job_id)
            if active_state is not None:
                ANALYSIS_CACHE_REQUESTS.labels(
                    layer="advanced_report",
                    result="singleflight",
                ).inc()
                response.status_code = status.HTTP_202_ACCEPTED
                return {
                    **active_state,
                    "reused_job": True,
                    "poll": (
                        "/api/v1/social/intelligence/advanced/report/jobs/"
                        f"{active_job_id}"
                    ),
                }

            # A reservation can outlive its job state if Redis was partially
            # evicted. Clear that exact stale owner and retry the reservation once.
            await release_analysis_reservation(fingerprint, active_job_id)
            active_job_id = await reserve_analysis_job(fingerprint, job_id)
            if active_job_id:
                response.status_code = status.HTTP_202_ACCEPTED
                return {
                    "job_id": active_job_id,
                    "status": "queued",
                    "reused_job": True,
                    "snapshot_id": payload.snapshot.get("snapshotId"),
                    "mint": mint,
                    "poll": (
                        "/api/v1/social/intelligence/advanced/report/jobs/"
                        f"{active_job_id}"
                    ),
                }
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Background analysis state is unavailable",
        ) from exc

    try:
        with ANALYSIS_STAGE_RUNTIME.labels(stage="preliminary").time():
            preliminary = await build_advanced_intelligence_report(
                session,
                snapshot=payload.snapshot,
                ai_result=payload.ai_result,
            )
        job_payload = {
            "fingerprint": fingerprint,
            "snapshot": payload.snapshot,
            "ai_result": payload.ai_result,
            "preliminary_report": preliminary,
            "persist": payload.persist,
            "enrich": payload.enrich,
            "role": payload.role,
        }
        await create_analysis_job(
            job_id,
            fingerprint=fingerprint,
            payload=job_payload,
            preliminary_report=preliminary,
        )
        enrich_report.apply_async(
            args=[job_id],
            task_id=job_id,
            queue="intelligence",
        )
    except Exception as exc:
        await fail_analysis_job(
            job_id,
            str(exc),
            fingerprint=fingerprint,
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Background analysis queue is unavailable",
        ) from exc

    response.status_code = status.HTTP_202_ACCEPTED
    return {
        "job_id": job_id,
        "status": "queued",
        "cached": False,
        "snapshot_id": payload.snapshot.get("snapshotId"),
        "mint": mint,
        "preliminary_report": preliminary,
        "poll": f"/api/v1/social/intelligence/advanced/report/jobs/{job_id}",
    }


@router.get("/report/jobs/{job_id}")
async def advanced_report_job(
    job_id: str,
    request: Request,
    x_backend_api_key: str | None = Header(
        default=None,
        alias="X-Backend-API-Key",
    ),
) -> dict:
    _require_backend_key(request, x_backend_api_key)
    if not job_id or len(job_id) > 128:
        raise HTTPException(status_code=400, detail="Invalid analysis job id")
    try:
        result = await read_analysis_job(job_id)
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Analysis job state is unavailable",
        ) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="Analysis job not found or expired")
    return result


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
