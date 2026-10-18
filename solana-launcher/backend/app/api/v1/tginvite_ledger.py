"""Owner-scoped ledger, safe cancellation and verified invitation reservations.

Reservations require server-verified consent; these endpoints never call Telegram.
"""

from __future__ import annotations

import base64
import binascii
from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_subscriber
from app.api.v1.tginvite_vault import _internal_only, _telegram_limit
from app.db.session import get_db
from app.models.telegram_invite_consent import TelegramInviteJob
from app.services.tginvite_consent_ledger import (
    ConsentLedgerError,
    claim_direct_invite,
    finish_direct_invite,
)
from app.services.tginvite_webhook_verify import TelegramWebhookInvalid, verify_operator_bindings

router = APIRouter(dependencies=[Depends(_internal_only)])


class InviteJobView(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    destination_chat_id: str
    status: str
    created_at: datetime


@router.get("/invite-jobs", response_model=list[InviteJobView])
async def list_invite_jobs(
    limit: int = Query(default=50, ge=1, le=100),
    owner=Depends(get_current_subscriber),
    db: AsyncSession = Depends(get_db),
) -> list[TelegramInviteJob]:
    """Never disclose recipient hashes, proof digests or cross-owner jobs."""
    statement = (
        select(TelegramInviteJob)
        .where(TelegramInviteJob.owner_id == str(owner.id))
        .order_by(TelegramInviteJob.created_at.desc(), TelegramInviteJob.id.desc())
        .limit(limit)
    )
    return list((await db.execute(statement)).scalars().all())


@router.post("/invite-jobs/{job_id}/cancel", status_code=204)
async def cancel_invite_job(
    job_id: UUID,
    owner=Depends(get_current_subscriber),
    db: AsyncSession = Depends(get_db),
) -> None:
    job = (
        await db.execute(
            select(TelegramInviteJob)
            .where(
                TelegramInviteJob.id == str(job_id),
                TelegramInviteJob.owner_id == str(owner.id),
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Invitation job not found")
    # Once an invocation is reserved, the worker may already be calling
    # Telegram. Do not claim cancellation can stop an in-flight API request.
    if job.status == "cancelled":
        return
    if job.status != "blocked_transport":
        raise HTTPException(status_code=409, detail="Only non-dispatching jobs may be cancelled")
    job.status = "cancelled"
    await db.commit()


class DirectInviteClaim(BaseModel):
    destination_chat_id: str = Field(pattern=r"^-[1-9][0-9]{0,19}$", max_length=21)
    recipient_telegram_id: str = Field(pattern=r"^[1-9][0-9]{0,19}$", max_length=20)
    idempotency_key: str = Field(pattern=r"^[A-Za-z0-9_-]{16,96}$", max_length=96)


class DirectInviteFinish(BaseModel):
    outcome: str = Field(pattern=r"^(invited|declined|unknown)$")


def _direct_consent_settings(request):
    """Fail closed if the dedicated bot, chat binding or digest key is missing."""
    settings = request.app.state.settings
    try:
        binding = verify_operator_bindings(
            settings.tginvite_consent_bot_id,
            settings.tginvite_consent_chat_bindings,
        )
        key = base64.b64decode(settings.tginvite_consent_hmac_key, validate=True)
        if len(key) < 32:
            raise ValueError("Invalid consent key")
    except (ValueError, binascii.Error, TelegramWebhookInvalid) as exc:
        raise HTTPException(status_code=503, detail="Direct invite opt-in not configured") from exc
    return binding, key


@router.post("/direct-invite/claim", status_code=201)
async def claim_direct_invite_endpoint(
    payload: DirectInviteClaim,
    request: Request,
    owner=Depends(get_current_subscriber),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """One authenticated and durable permission to invoke Telegram once.

    The receiver must perform the MTProto call. No browser-controlled
    boolean, username, parser label, or join-request alone grants permission.
    """
    binding, key = _direct_consent_settings(request)
    if binding.bindings.get(payload.destination_chat_id) != str(owner.id):
        raise HTTPException(status_code=403, detail="Destination is not approved for your account")
    # Shared quota is required before reserving the permanent deduplication key.
    limit = await _telegram_limit(
        request, f"tginvite-direct-invite:{owner.id}", limit=5, window_seconds=3600,
    )
    if not limit.allowed:
        raise HTTPException(status_code=429, detail="Direct invite rate limit reached",
                            headers={"Retry-After": str(limit.retry_after)})
    try:
        job = await claim_direct_invite(
            db,
            owner_id=str(owner.id),
            destination_chat_id=payload.destination_chat_id,
            recipient_telegram_id=payload.recipient_telegram_id,
            telegram_bot_id=binding.bot_id,
            hmac_key=key,
            idempotency_key=payload.idempotency_key,
        )
    except ConsentLedgerError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return {"jobId": str(job.id), "status": job.status}


@router.post("/direct-invite/{job_id}/finish")
async def finish_direct_invite_endpoint(
    job_id: UUID,
    payload: DirectInviteFinish,
    owner=Depends(get_current_subscriber),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        job = await finish_direct_invite(
            db, owner_id=str(owner.id), job_id=str(job_id),
            outcome=payload.outcome,
        )
    except ConsentLedgerError:
        raise HTTPException(
            status_code=409, detail="Direct invite job cannot be finalized",
        ) from None
    return {"jobId": str(job.id), "status": job.status}
