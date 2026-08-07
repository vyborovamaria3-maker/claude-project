from __future__ import annotations

import hmac
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_superuser
from app.db.session import get_db
from app.schemas.social_intelligence import (
    TelegramAttachSessionRequest,
    TelegramMonitorRequest,
    TelegramScanRequest,
    XSocialIngestRequest,
)
from app.services.social_intelligence import (
    evaluate_calls,
    ingest_x_events,
    list_calls,
    list_channels,
    list_social_relations,
    refresh_x_for_mint,
    token_timeline,
    top_callers,
)
from app.services.telegram_intelligence import TelegramSessionError
from app.services.telegram_parser import is_solana_address
from app.services.telegram_runtime import TelegramMonitorManager

logger = logging.getLogger(__name__)
router = APIRouter()
social_router = APIRouter()


def _manager(request: Request) -> TelegramMonitorManager:
    return request.app.state.telegram_intelligence


@router.get("/session/status")
async def telegram_session_status(
    request: Request,
    current_user=Depends(get_current_superuser),
) -> dict:
    return _manager(request).status()


@router.post("/session/login")
async def telegram_attach_session(
    payload: TelegramAttachSessionRequest,
    request: Request,
    current_user=Depends(get_current_superuser),
) -> dict:
    # Attach only a pre-authorized StringSession. Phone/SMS login is intentionally kept out
    # of HTTP APIs and the session secret is never returned to clients.
    try:
        return await _manager(request).attach_session(payload.session_string)
    except (TelegramSessionError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.post("/scan")
async def scan_telegram(
    payload: TelegramScanRequest,
    request: Request,
    current_user=Depends(get_current_superuser),
) -> dict:
    try:
        service = await _manager(request).get_service()
        return await service.scan_graph(
            payload.seeds,
            max_depth=payload.max_depth,
            post_limit=payload.post_limit,
            entity_limit=payload.entity_limit,
        )
    except (TelegramSessionError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.post("/monitor/start")
async def start_monitor(
    payload: TelegramMonitorRequest,
    request: Request,
    current_user=Depends(get_current_superuser),
) -> dict:
    try:
        service = await _manager(request).get_service()
        return await service.start_monitor(payload.channels)
    except (TelegramSessionError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.post("/monitor/stop")
async def stop_monitor(request: Request, current_user=Depends(get_current_superuser)) -> dict:
    manager = _manager(request)
    if manager.service is None:
        return {"running": False, "channels": []}
    return await manager.service.stop_monitor()


@router.get("/monitor/status")
async def monitor_status(
    request: Request,
    current_user=Depends(get_current_superuser),
) -> dict:
    return _manager(request).status()


@router.get("/channels")
async def channels(
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    session: AsyncSession = Depends(get_db),
) -> dict:
    items, total = await list_channels(session, limit=limit, offset=offset)
    return {"items": items, "meta": {"limit": limit, "offset": offset, "total": total}}


@router.get("/calls")
async def calls(
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    channel_id: int | None = Query(default=None),
    mint: str | None = Query(default=None),
    session: AsyncSession = Depends(get_db),
) -> dict:
    if mint and not is_solana_address(mint):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Solana mint address")
    items, total = await list_calls(session, limit=limit, offset=offset, channel_id=channel_id, mint_address=mint)
    return {"items": items, "meta": {"limit": limit, "offset": offset, "total": total}}


@router.post("/calls/evaluate")
async def evaluate(
    limit: int = Query(default=1000, ge=1, le=5000),
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_superuser),
) -> dict:
    return await evaluate_calls(session, limit=limit)


@router.get("/token/{mint}")
async def telegram_token(mint: str, session: AsyncSession = Depends(get_db)) -> dict:
    if not is_solana_address(mint):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Solana mint address")
    timeline = await token_timeline(session, mint)
    timeline["timeline"] = [item for item in timeline["timeline"] if item["platform"] == "telegram"]
    timeline["mentions"] = len(timeline["timeline"])
    timeline["platforms"] = {"telegram": timeline["mentions"]} if timeline["mentions"] else {}
    timeline["origin"] = timeline["timeline"][0] if timeline["timeline"] else None
    return timeline


@router.get("/top-callers")
async def callers(
    limit: int = Query(default=50, ge=1, le=250),
    session: AsyncSession = Depends(get_db),
) -> dict:
    return {"items": await top_callers(session, limit=limit)}


@social_router.get("/relations")
async def social_relations(
    source_handle: str | None = Query(default=None),
    platform: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    session: AsyncSession = Depends(get_db),
) -> dict:
    if platform and platform not in {"telegram", "x"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="platform must be telegram or x")
    return {
        "items": await list_social_relations(
            session, source_handle=source_handle, platform=platform, limit=limit
        )
    }


@social_router.get("/token/{mint}")
async def social_token(mint: str, session: AsyncSession = Depends(get_db)) -> dict:
    if not is_solana_address(mint):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Solana mint address")
    return await token_timeline(session, mint)


@social_router.post("/x/refresh/{mint}")
async def refresh_x(
    mint: str,
    request: Request,
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_superuser),
) -> dict:
    if not is_solana_address(mint):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Solana mint address")
    try:
        payload = await refresh_x_for_mint(
            backend_frontend_url=request.app.state.settings.frontend_internal_url,
            mint_address=mint,
        )
        return await ingest_x_events(session, payload)
    except Exception as exc:
        logger.exception("X intelligence refresh failed for mint %s", mint)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="X intelligence refresh failed",
        ) from exc


@social_router.post("/x/ingest")
async def x_ingest(
    payload: XSocialIngestRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
    x_backend_api_key: str | None = Header(default=None, alias="X-Backend-API-Key"),
) -> dict:
    expected = request.app.state.settings.backend_api_key
    if not expected:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="BACKEND_API_KEY is not configured")
    if not x_backend_api_key or not hmac.compare_digest(x_backend_api_key, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid backend API key")
    if not is_solana_address(payload.token_mint):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Solana mint address")
    return await ingest_x_events(session, payload.model_dump())
