from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.schemas.token import Message

router = APIRouter()


@router.get("/health", response_model=Message)
async def health() -> Message:
    return Message(detail="ok")


@router.get("/ready", response_model=Message)
async def ready(session: AsyncSession = Depends(get_db)) -> Message:
    await session.execute(text("SELECT 1"))
    return Message(detail="ready")
