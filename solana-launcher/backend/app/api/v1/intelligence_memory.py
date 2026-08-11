from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_subscriber
from app.db.session import get_db
from app.services.intelligence_memory import (
    build_memory_context,
    entity_memory,
    persist_intelligence_memory,
    token_memory_history,
)
from app.services.telegram_parser import is_solana_address

router = APIRouter()


class IntelligenceMemoryPersistRequest(BaseModel):
    snapshot: dict
    analysis_snapshot: dict | None = None
    ai_result: dict | None = None
    provider: str | None = Field(default=None, max_length=64)
    model: str | None = Field(default=None, max_length=160)
    prompt_version: str | None = Field(default=None, max_length=80)


class IntelligenceMemoryContextRequest(BaseModel):
    entity_keys: list[str] = Field(default_factory=list, max_length=100)
    mint: str | None = Field(default=None, max_length=64)
    max_entities: int = Field(default=40, ge=1, le=100)
    max_edges: int = Field(default=120, ge=1, le=300)


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


@router.post("/memory")
async def persist_memory(
    payload: IntelligenceMemoryPersistRequest,
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
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid snapshot mint",
        )
    if payload.analysis_snapshot is not None:
        analysis_mint = str(payload.analysis_snapshot.get("mint") or "")
        if analysis_mint != mint:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="analysis_snapshot mint mismatch",
            )
    try:
        return await persist_intelligence_memory(
            session,
            snapshot=payload.snapshot,
            analysis_snapshot=payload.analysis_snapshot,
            ai_result=payload.ai_result,
            provider=payload.provider,
            model=payload.model,
            prompt_version=payload.prompt_version,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc


@router.get("/history/{mint}")
async def memory_history(
    mint: str,
    limit: int = Query(default=20, ge=1, le=100),
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_subscriber),
) -> dict:
    if not is_solana_address(mint):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid Solana mint address",
        )
    return {"items": await token_memory_history(session, mint, limit=limit)}


@router.get("/entity")
async def memory_entity(
    key: str = Query(min_length=1, max_length=160),
    edge_limit: int = Query(default=100, ge=1, le=300),
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_subscriber),
) -> dict:
    result = await entity_memory(session, key, edge_limit=edge_limit)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Entity not found",
        )
    return result


@router.post("/context")
async def memory_context(
    payload: IntelligenceMemoryContextRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
    x_backend_api_key: str | None = Header(
        default=None,
        alias="X-Backend-API-Key",
    ),
) -> dict:
    _require_backend_key(request, x_backend_api_key)
    if payload.mint and not is_solana_address(payload.mint):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid Solana mint address",
        )
    return await build_memory_context(
        session,
        entity_keys=payload.entity_keys,
        mint=payload.mint,
        max_entities=payload.max_entities,
        max_edges=payload.max_edges,
    )
