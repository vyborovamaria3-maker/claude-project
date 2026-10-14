"""Server-to-server credential vault. Never expose this resource to a browser."""

from __future__ import annotations

import hmac
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_subscriber
from app.core.rate_limit import RateLimiterUnavailable, RateLimitResult
from app.db.session import get_db
from app.models.telegram_invite_session import TelegramInviteSession
from app.services.telegram_collector.user_history import (
    load_public_history,
    normalize_public_channel,
)
from app.services.tginvite_login_lease import (
    TelegramLoginLeaseUnavailable,
    acquire_login_lease,
    release_login_lease,
    reset_login_lease,
    verify_login_lease,
)
from app.services.telegram_invite_vault import (
    TelegramInviteVaultError,
    _key,
    decrypt_session,
    encrypt_session,
)

router = APIRouter()


async def _telegram_limit(
    request: Request, key: str, *, limit: int, window_seconds: int
) -> RateLimitResult:
    """Use cross-worker quotas in production; never fail open on a Redis outage."""
    strict = request.app.state.settings.environment.strip().lower() in {"production", "prod"}
    try:
        return await request.app.state.rate_limiter.allow(
            key, limit=limit, window_seconds=window_seconds, require_shared=strict
        )
    except RateLimiterUnavailable as exc:
        raise HTTPException(
            status_code=503, detail="Telegram request protection unavailable"
        ) from exc


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
        raise HTTPException(
            status_code=503, detail="Telegram session vault is unavailable"
        ) from exc
    return key


def _previous_vault_keys(request: Request) -> tuple[str, ...]:
    configured = request.app.state.settings.tginvite_session_previous_keys
    keys = tuple(entry.strip() for entry in configured.split(",") if entry.strip())
    if len(keys) > 4:
        raise HTTPException(status_code=503, detail="Too many previous Telegram vault keys")
    try:
        for key in keys:
            _key(key)
    except TelegramInviteVaultError as exc:
        raise HTTPException(
            status_code=503, detail="Telegram vault rotation keys are invalid"
        ) from exc
    return keys


@router.get(
    "/session", response_model=StoredTelegramSession, dependencies=[Depends(_internal_only)]
)
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
        stored_payload = decrypt_session(
            str(owner.id), row.encrypted_payload, key, _previous_vault_keys(request)
        )
        return StoredTelegramSession.model_validate(stored_payload)
    except (TelegramInviteVaultError, ValueError) as exc:
        raise HTTPException(
            status_code=503, detail="Stored Telegram session cannot be decrypted"
        ) from exc


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
            select(TelegramInviteSession)
            .where(TelegramInviteSession.owner_id == str(owner.id))
            .with_for_update()
        )
    ).scalar_one_or_none()
    if row is None:
        db.add(TelegramInviteSession(owner_id=str(owner.id), encrypted_payload=encrypted))
    else:
        row.encrypted_payload = encrypted
    try:
        await db.commit()
    except IntegrityError as exc:
        # Concurrent inserts must not silently replace a different worker's
        # newly authenticated session. Require the caller to retry explicitly.
        await db.rollback()
        raise HTTPException(
            status_code=409, detail="Telegram session changed concurrently; reconnect"
        ) from exc
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
            select(TelegramInviteSession)
            .where(TelegramInviteSession.owner_id == str(owner.id))
            .with_for_update()
        )
    ).scalar_one_or_none()
    if row is not None:
        await db.delete(row)
        await db.commit()
    return Response(status_code=204)


class TelegramLoginAttemptRequest(BaseModel):
    kind: Literal["send_code", "complete_login"]


@router.post("/login-attempt", status_code=204, dependencies=[Depends(_internal_only)])
async def limit_telegram_login_attempt(
    payload: TelegramLoginAttemptRequest,
    request: Request,
    owner=Depends(get_current_subscriber),
) -> Response:
    """Shared per-user login throttle, enforced before any Telegram auth request.

    The existing rate-limiter uses Redis when available and a memory fallback in
    development; configure Redis for cross-worker enforcement in production.
    """
    caps = {
        "send_code": (3, 600),
        "complete_login": (8, 600),
    }
    limit, period = caps[payload.kind]
    result = await _telegram_limit(
        request, f"tginvite-login:{payload.kind}:{owner.id}",
        limit=limit, window_seconds=period,
    )
    if not result.allowed:
        raise HTTPException(
            status_code=429,
            detail="Too many Telegram login attempts",
            headers={"Retry-After": str(result.retry_after)},
        )
    return Response(status_code=204)


class TelegramLoginLeaseRequest(BaseModel):
    action: Literal["acquire", "verify", "release", "reset"]
    token: str | None = Field(default=None, min_length=32, max_length=128)


@router.post("/login-lease", dependencies=[Depends(_internal_only)])
async def telegram_login_lease(
    payload: TelegramLoginLeaseRequest,
    request: Request,
    owner=Depends(get_current_subscriber),
) -> Response:
    """Shared login challenge fence, never exposed to unauthenticated clients."""
    if payload.action in {"verify", "release"} and not payload.token:
        raise HTTPException(status_code=422, detail="Login lease token required")
    try:
        redis = request.app.state.redis
        owner_id = str(owner.id)
        if payload.action == "acquire":
            token = await acquire_login_lease(redis, owner_id)
            if token is None:
                raise HTTPException(
                    status_code=409, detail="Another Telegram login is in progress"
                )
            return JSONResponse(
                {"token": token},
                headers={"Cache-Control": "private, no-store"},
            )
        if payload.action == "verify":
            if not await verify_login_lease(redis, owner_id, payload.token or ""):
                raise HTTPException(status_code=409, detail="Telegram login lease expired")
        elif payload.action == "release":
            if not await release_login_lease(redis, owner_id, payload.token or ""):
                raise HTTPException(status_code=409, detail="Telegram login lease changed")
        else:
            await reset_login_lease(redis, owner_id)
        return Response(status_code=204)
    except TelegramLoginLeaseUnavailable as exc:
        raise HTTPException(
            status_code=503, detail="Shared Telegram login coordination unavailable"
        ) from exc


class TelegramReadPermitRequest(BaseModel):
    kind: Literal[
        "fetch_members", "analyze_recent", "validate_candidates",
        "create_invite_link", "batch_invite_links",
    ]


@router.post("/read-permit", status_code=204, dependencies=[Depends(_internal_only)])
async def rate_limit_telegram_reads(
    payload: TelegramReadPermitRequest,
    request: Request,
    owner=Depends(get_current_subscriber),
) -> Response:
    """Bound expensive Telegram reads per owner across application workers.

    This is an abuse guard, not a mechanism to override Telegram rate limits.
    """
    caps = {
        "fetch_members": (6, 60),
        "analyze_recent": (10, 60),
        "validate_candidates": (2, 60),
        "create_invite_link": (6, 60),
        "batch_invite_links": (2, 60),
    }
    limit, window_seconds = caps[payload.kind]
    result = await _telegram_limit(
        request, f"tginvite-read:{payload.kind}:{owner.id}",
        limit=limit, window_seconds=window_seconds,
    )
    if not result.allowed:
        raise HTTPException(
            status_code=429,
            detail="Too many Telegram read requests",
            headers={"Retry-After": str(result.retry_after)},
        )
    return Response(status_code=204)


class TelegramHistoryRequest(BaseModel):
    username: str = Field(min_length=5, max_length=33)
    limit: int = Field(default=100, ge=1, le=200)


@router.post("/messages", dependencies=[Depends(_internal_only)])
async def read_user_channel_history(
    payload: TelegramHistoryRequest,
    request: Request,
    owner=Depends(get_current_subscriber),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Read a bounded set of messages using only the caller's server-side user session.

    Deliberately rejects invitation hashes and private-join links. This endpoint does
    not add Telegram memberships or persist message contents in shared tables.
    """
    try:
        username = normalize_public_channel(payload.username)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    rate = await _telegram_limit(
        request, f"tg-history:{owner.id}", limit=6, window_seconds=60
    )
    if not rate.allowed:
        raise HTTPException(
            status_code=429,
            detail="Too many history requests",
            headers={"Retry-After": str(rate.retry_after)},
        )

    row = (
        await db.execute(
            select(TelegramInviteSession).where(TelegramInviteSession.owner_id == str(owner.id))
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Connect your Telegram account first")

    try:
        stored = StoredTelegramSession.model_validate(
            decrypt_session(
                str(owner.id), row.encrypted_payload,
                _vault_key(request), _previous_vault_keys(request)
            )
        )
    except (TelegramInviteVaultError, ValueError) as exc:
        raise HTTPException(status_code=503, detail="Telegram session is unavailable") from exc

    try:
        messages = await load_public_history(
            api_id=stored.api_id,
            api_hash=stored.api_hash,
            session_string=stored.session_string,
            username=username,
            limit=payload.limit,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        "source": username,
        "coverage": "recent_accessible_messages",
        "complete_history": False,
        "messages": messages,
        "count": len(messages),
    }
