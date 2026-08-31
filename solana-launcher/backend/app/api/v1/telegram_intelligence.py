from __future__ import annotations

import hmac
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_subscriber, get_current_superuser
from app.db.session import get_db
from app.schemas.social_intelligence import (
    TelegramAttachSessionRequest,
    TelegramMonitorRequest,
    TelegramScanRequest,
    XSocialIngestRequest,
)
from app.services.social_filters import filter_timeline_payload, normalize_social_source
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
from app.services.telegram_public_web import TelegramPublicWebError
from app.services.telegram_runtime import TelegramMonitorManager

logger = logging.getLogger(__name__)
router = APIRouter()
social_router = APIRouter()


def _manager(request: Request) -> TelegramMonitorManager:
    return request.app.state.telegram_intelligence


def _safe_collector_status(request: Request) -> dict:
    runtime = _manager(request).status()
    channels = runtime.get("channels") or []
    return {
        "mode": runtime.get("mode") or "unavailable",
        "configured": bool(runtime.get("configured")),
        "mtproto_configured": bool(runtime.get("mtproto_configured")),
        "session_configured": bool(runtime.get("session_configured")),
        "running": bool(runtime.get("running")),
        "connected": bool(runtime.get("connected")),
        "monitored_channels": len(channels) if isinstance(channels, list) else 0,
        "public_web_enabled": bool(runtime.get("public_web_enabled")),
        "public_web_configured": bool(runtime.get("public_web_configured")),
        "public_web_channels": int(runtime.get("public_web_channels") or 0),
        "last_scan_at": runtime.get("last_scan_at"),
        "last_scan_messages": int(runtime.get("last_scan_messages") or 0),
        "last_scan_matches": int(runtime.get("last_scan_matches") or 0),
        "last_error": runtime.get("last_error"),
    }


def _source_set(raw: str | None) -> set[str]:
    if not raw:
        return set()
    return {normalize_social_source(value) for value in raw.split(",") if value.strip()}


async def _channel_scores(session: AsyncSession) -> dict[str, float]:
    result: dict[str, float] = {}
    offset = 0
    while True:
        channels, total = await list_channels(session, limit=500, offset=offset)
        for item in channels:
            score = float(item.get("score") or 0.0)
            username = str(item.get("username") or "").strip()
            telegram_id = str(item.get("telegram_id") or "").strip()
            if username:
                result[normalize_social_source(username)] = score
            if telegram_id:
                result[normalize_social_source(telegram_id)] = score
        offset += len(channels)
        if not channels or offset >= total:
            break
    return result


async def _filtered_timeline(
    session: AsyncSession,
    mint: str,
    *,
    platform: str | None,
    hours: int | None,
    sources: str | None,
    explicit_calls_only: bool,
    min_engagement: int,
    min_channel_score: float,
    limit: int,
) -> dict:
    timeline = await token_timeline(session, mint)
    scores = await _channel_scores(session) if min_channel_score > 0 else {}
    return filter_timeline_payload(
        timeline,
        platform=platform,
        hours=hours,
        sources=_source_set(sources),
        explicit_calls_only=explicit_calls_only,
        min_engagement=min_engagement,
        min_channel_score=min_channel_score,
        channel_scores=scores,
        limit=limit,
    )


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


@router.post("/public-web/scan")
async def scan_telegram_public_web(
    payload: TelegramScanRequest,
    request: Request,
    current_user=Depends(get_current_superuser),
) -> dict:
    try:
        return await _manager(request).scan_public_web(
            payload.seeds,
            history_limit=min(payload.post_limit, 500),
        )
    except (TelegramPublicWebError, ValueError) as exc:
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
    current_user=Depends(get_current_subscriber),
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
    current_user=Depends(get_current_subscriber),
) -> dict:
    if mint and not is_solana_address(mint):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Solana mint address")
    items, total = await list_calls(session, limit=limit, offset=offset, channel_id=channel_id, mint_address=mint)
    return {"items": items, "meta": {"limit": limit, "offset": offset, "total": total}}


@router.post("/calls/evaluate")
async def evaluate(
    limit: int = Query(default=1000, ge=1, le=5000),
    window_hours: int = Query(default=72, ge=6, le=24 * 30),
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_superuser),
) -> dict:
    return await evaluate_calls(session, limit=limit, window_hours=window_hours)


@router.get("/token/{mint}")
async def telegram_token(
    mint: str,
    request: Request,
    hours: int | None = Query(default=None, ge=1, le=8760),
    sources: str | None = Query(default=None, description="Comma-separated Telegram channel usernames"),
    explicit_calls_only: bool = Query(default=False),
    min_engagement: int = Query(default=0, ge=0, le=1_000_000_000),
    min_channel_score: float = Query(default=0.0, ge=0.0, le=100.0),
    limit: int = Query(default=200, ge=1, le=1000),
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_subscriber),
) -> dict:
    if not is_solana_address(mint):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Solana mint address")
    payload = await _filtered_timeline(
        session,
        mint,
        platform="telegram",
        hours=hours,
        sources=sources,
        explicit_calls_only=explicit_calls_only,
        min_engagement=min_engagement,
        min_channel_score=min_channel_score,
        limit=limit,
    )
    payload.setdefault("meta", {})["telegramCollector"] = _safe_collector_status(request)
    return payload


@router.get("/top-callers")
async def callers(
    limit: int = Query(default=50, ge=1, le=250),
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_subscriber),
) -> dict:
    return {"items": await top_callers(session, limit=limit)}


@social_router.get("/relations")
async def social_relations(
    source_handle: str | None = Query(default=None),
    platform: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_subscriber),
) -> dict:
    if platform and platform not in {"telegram", "x"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="platform must be telegram or x")
    return {
        "items": await list_social_relations(
            session, source_handle=source_handle, platform=platform, limit=limit
        )
    }


@social_router.get("/token/{mint}")
async def social_token(
    mint: str,
    request: Request,
    platform: str | None = Query(default=None),
    hours: int | None = Query(default=None, ge=1, le=8760),
    sources: str | None = Query(default=None, description="Comma-separated source handles"),
    explicit_calls_only: bool = Query(default=False),
    min_engagement: int = Query(default=0, ge=0, le=1_000_000_000),
    min_channel_score: float = Query(default=0.0, ge=0.0, le=100.0),
    limit: int = Query(default=200, ge=1, le=1000),
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_subscriber),
) -> dict:
    if not is_solana_address(mint):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Solana mint address")
    if platform and platform not in {"telegram", "x"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="platform must be telegram or x")
    payload = await _filtered_timeline(
        session,
        mint,
        platform=platform,
        hours=hours,
        sources=sources,
        explicit_calls_only=explicit_calls_only,
        min_engagement=min_engagement,
        min_channel_score=min_channel_score,
        limit=limit,
    )
    if platform in {None, "telegram"}:
        payload.setdefault("meta", {})["telegramCollector"] = _safe_collector_status(request)
    return payload


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
