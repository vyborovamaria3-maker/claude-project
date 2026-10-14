"""Read-only owner-scoped TGInvite job ledger and safe job cancellation.

No HTTP endpoint accepts consent claims or can create/send invitations.
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_subscriber
from app.api.v1.tginvite_vault import _internal_only
from app.db.session import get_db
from app.models.telegram_invite_consent import TelegramInviteJob

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
    job.status = "cancelled"
    await db.commit()
