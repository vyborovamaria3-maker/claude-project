from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.deps import get_current_superuser
from app.services.telegram_parser import is_solana_address
from app.tasks.social import refresh_x

router = APIRouter()


@router.post("/x/refresh/{mint}/async", status_code=status.HTTP_202_ACCEPTED)
async def refresh_x_async(
    mint: str,
    current_user=Depends(get_current_superuser),
) -> dict:
    if not is_solana_address(mint):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid Solana mint address",
        )
    result = refresh_x.apply_async(args=[mint], queue="social")
    return {
        "task_id": result.id,
        "status": "queued",
        "mint": mint,
        "queue": "social",
    }
