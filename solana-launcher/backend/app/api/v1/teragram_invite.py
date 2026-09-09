from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from app.api.deps import get_current_subscriber
from app.services.teragram_invite_source import (
    get_teragram_invite_status,
    list_teragram_invite_channels,
)

router = APIRouter()


@router.get("/status")
async def teragram_invite_status(
    request: Request,
    current_user=Depends(get_current_subscriber),
) -> dict:
    active_seed_database = str(
        getattr(request.app.state.settings, "telegram_public_web_seed_database", "") or ""
    )
    return get_teragram_invite_status(active_seed_database=active_seed_database)


@router.get("/channels")
async def teragram_invite_channels(
    limit: int = Query(default=250, ge=1, le=5000),
    classification: str | None = Query(default=None),
    current_user=Depends(get_current_subscriber),
) -> dict:
    try:
        items, total = list_teragram_invite_channels(
            limit=limit,
            classification=classification,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return {
        "items": items,
        "meta": {
            "limit": limit,
            "total": total,
            "classification": classification,
        },
    }
