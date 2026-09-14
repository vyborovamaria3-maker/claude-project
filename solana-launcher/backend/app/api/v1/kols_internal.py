from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.services.kol_intelligence import build_kol_token_intelligence
from app.services.telegram_parser import is_solana_address

router = APIRouter()


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


@router.get("/internal/token/{mint_address}")
async def internal_token_kol_intelligence(
    mint_address: str,
    request: Request,
    session: AsyncSession = Depends(get_db),
    x_backend_api_key: str | None = Header(default=None, alias="X-Backend-API-Key"),
) -> dict:
    _require_backend_key(request, x_backend_api_key)
    if not is_solana_address(mint_address):
        raise HTTPException(status_code=400, detail="Invalid Solana mint address")
    return await build_kol_token_intelligence(session, mint_address)
