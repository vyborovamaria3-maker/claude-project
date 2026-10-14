"""Server-to-server credential vault. Never expose this resource to a browser."""

from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_subscriber
from app.db.session import get_db
from app.models.telegram_invite_session import TelegramInviteSession
from app.services.telegram_invite_vault import (
    TelegramInviteVaultError,
    _key,
    decrypt_session,
    encrypt_session,
)

router = APIRouter()


class StoredTelegramSession(BaseModel):
    api_id: int = Field(ge=1)
    api_hash: str = Field(min_length=16, max_length=128)
    session_string: str = Field(min_length=8, max_length=20000)


def _internal_only(
    request: Request,
    service_key: str | None = Header(None, alias="X-TGInvite-Service-Key"),
) -> None:
    settings = request.app.state.settings
    expected = settings.tginvite_internal_key
    if not expected or len(expected) < 32:
        raise HTTPException(status_code=503, detail="Telegram session vault is not configured")
    if not service_key or not hmac.compare_digest(
        service_key.encode("utf-8"), expected.encode("utf-8")
    ):
        raise HTTPException(status_code=403, detail="Forbidden")


def _vault_key(request: Request) -> str:
    key = request.app.state.settings.tginvite_session_encryption_key
    try:
        # Validate configuration even if the database contains no session yet.
        _key(key)
    except TelegramInviteVaultError as exc:
        raise HTTPException(status_code=503, detail="Telegram session vault is unavailable") from exc
    return key


@router.get("/session", response_model=StoredTelegramSession, dependencies=[Depends(_internal_only)])
async def get_session(
    request: Request,
    owner=Depends(get_current_subscriber),
    db: AsyncSession = Depends(get_db),
) -> StoredTelegramSession:
    key = _vault_key(request)
    row = (
        await db.execute(
            select(TelegramInviteSession).where(TelegramInviteSession.owner_id == str(owner.id))
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="No stored Telegram session")
    try:
        return StoredTelegramSession.model_validate(decrypt_session(str(owner.id), row.encrypted_payload, key))
    except (TelegramInviteVaultError, ValueError) as exc:
        raise HTTPException(status_code=503, detail="Stored Telegram session cannot be decrypted") from exc


@router.put("/session", status_code=204, dependencies=[Depends(_internal_only)])
async def store_session(
    payload: StoredTelegramSession,
    request: Request,
    owner=Depends(get_current_subscriber),
    db: AsyncSession = Depends(get_db),
) -> Response:
    encrypted = encrypt_session(str(owner.id), payload.model_dump(), _vault_key(request))
    row = (
        await db.execute(
            select(TelegramInviteSession).where(TelegramInviteSession.owner_id == str(owner.id))
        )
    ).scalar_one_or_none()
    if row is None:
        db.add(TelegramInviteSession(owner_id=str(owner.id), encrypted_payload=encrypted))
    else:
        row.encrypted_payload = encrypted
    await db.commit()
    return Response(status_code=204)


@router.delete("/session", status_code=204, dependencies=[Depends(_internal_only)])
async def delete_session(
    request: Request,
    owner=Depends(get_current_subscriber),
    db: AsyncSession = Depends(get_db),
) -> Response:
    _vault_key(request)
    row = (
        await db.execute(
            select(TelegramInviteSession).where(TelegramInviteSession.owner_id == str(owner.id))
        )
    ).scalar_one_or_none()
    if row is not None:
        await db.delete(row)
        await db.commit()
    return Response(status_code=204)
