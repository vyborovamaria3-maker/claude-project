"""Verified Telegram join-request webhook for opt-in-only evidence.

This route cannot send invitations, accept browser consent, or create jobs.
It is disabled unless a trusted operator configures *all* required settings.
"""

from __future__ import annotations

import base64
import binascii
import hmac
import json
import re

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.services.tginvite_consent_ledger import ConsentLedgerError, record_verified_opt_in
from app.services.tginvite_webhook_verify import (
    TelegramWebhookInvalid,
    verified_direct_invite_request,
    verified_join_request,
    verify_operator_bindings,
)

router = APIRouter()

MAX_WEBHOOK_BYTES = 32 * 1024
_SECRET_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,256}$")


@router.post("/consent-webhook", status_code=204)
async def receive_telegram_join_request(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> Response:
    settings = request.app.state.settings
    secret = settings.tginvite_consent_webhook_secret
    # For this dedicated bot, setWebhook(secret_token=...) must match the
    # configured secret. Credentials MUST NOT be inherited from the main bot.
    if not secret or not _SECRET_PATTERN.fullmatch(secret):
        raise HTTPException(status_code=503, detail="TGInvite consent webhook disabled")

    supplied = request.headers.get("x-telegram-bot-api-secret-token", "")
    if not supplied or not hmac.compare_digest(supplied, secret):
        raise HTTPException(status_code=403, detail="Forbidden")

    try:
        identity = verify_operator_bindings(
            settings.tginvite_consent_bot_id,
            settings.tginvite_consent_chat_bindings,
        )
        digest_key = base64.b64decode(
            settings.tginvite_consent_hmac_key, validate=True
        )
        if len(digest_key) < 32:
            raise ValueError("Key too short")
    except (TelegramWebhookInvalid, ValueError, binascii.Error, TypeError) as exc:
        raise HTTPException(
            status_code=503, detail="TGInvite consent webhook disabled"
        ) from exc

    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        raise HTTPException(status_code=415, detail="Expected JSON")
    declared = request.headers.get("content-length")
    if declared and (not declared.isdecimal() or int(declared) > MAX_WEBHOOK_BYTES):
        raise HTTPException(status_code=413, detail="Telegram update too large")

    # Bound even chunked requests. Never log or store the original update.
    chunks: list[bytes] = []
    length = 0
    async for part in request.stream():
        length += len(part)
        if length > MAX_WEBHOOK_BYTES:
            raise HTTPException(status_code=413, detail="Telegram update too large")
        chunks.append(part)
    try:
        update = json.loads(b"".join(chunks))
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=422, detail="Invalid Telegram update") from exc
    try:
        verified = verified_join_request(update, settings=identity)
        if verified is None:
            verified = verified_direct_invite_request(update, settings=identity)
    except TelegramWebhookInvalid as exc:
        raise HTTPException(status_code=422, detail="Invalid Telegram consent request") from exc
    # Only a verified chat join request or an explicit private /join command
    # authorizes a scoped proof. Other Telegram messages are ignored.
    if verified is None:
        return Response(status_code=204)
    try:
        await record_verified_opt_in(db, verified, hmac_key=digest_key)
    except ConsentLedgerError as exc:
        raise HTTPException(status_code=409, detail="Telegram opt-in proof conflict") from exc
    return Response(status_code=204)
