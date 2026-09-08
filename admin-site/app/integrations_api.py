from __future__ import annotations

import hmac
import os
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from .auth import require_admin
from .integration_secrets import IntegrationSecretError, IntegrationSecretStore


router = APIRouter()


class HeliusKeyBody(BaseModel):
    name: str = Field(default="Helius API key", min_length=1, max_length=80)
    api_key: str = Field(min_length=8, max_length=512)


class IntegrationEnabledBody(BaseModel):
    enabled: bool


class TelegramCredentialsBody(BaseModel):
    api_id: int = Field(gt=0, lt=2_147_483_647)
    api_hash: str = Field(min_length=16, max_length=256)


class TelegramSessionBody(BaseModel):
    session_string: str = Field(min_length=20, max_length=65_536)


def _store(request: Request, *, require_configured: bool = False) -> IntegrationSecretStore:
    store: IntegrationSecretStore = request.app.state.integrations
    if require_configured and not store.configured:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Integration secret storage is not configured",
        )
    return store


def _audit(request: Request, admin: dict[str, Any], action: str, resource: str | None = None, details: dict[str, Any] | None = None, success: bool = True) -> None:
    request.app.state.audit.record(
        action=action,
        success=success,
        username=admin.get("sub"),
        ip_address=request.client.host if request.client else None,
        resource=resource,
        details=details or {},
    )


def _service_token_for_path(path: str) -> str:
    if path == "/internal/integrations/helius":
        return os.getenv("ADMIN_HELIUS_SERVICE_TOKEN", "").strip()
    if path == "/internal/integrations/telegram":
        return os.getenv("ADMIN_TELEGRAM_SERVICE_TOKEN", "").strip()
    return ""


def is_authorized_internal_request(request: Request) -> bool:
    """Allow only scoped, read-only service calls to bypass the admin IP allowlist."""
    expected = _service_token_for_path(request.url.path)
    supplied = request.headers.get("x-integration-service-key", "").strip()
    return bool(len(expected) >= 32 and supplied and hmac.compare_digest(expected, supplied))


def _require_internal_service(request: Request) -> None:
    if not is_authorized_internal_request(request):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid integration service credential")


def _telegram_summary(store: IntegrationSecretStore) -> dict[str, Any]:
    rows = {row["kind"]: row for row in store.list("telegram")}
    return {
        "api_id": rows.get("api_id"),
        "api_hash": rows.get("api_hash"),
        "session_string": rows.get("session_string"),
        "credentials_configured": bool(rows.get("api_id") and rows.get("api_hash")),
        "session_configured": bool(rows.get("session_string")),
    }


@router.get("/api/integrations")
def integrations_summary(request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
    store = _store(request)
    return {
        "secret_storage_configured": store.configured,
        "helius": {"keys": store.list("helius", "api_key")},
        "telegram": _telegram_summary(store),
    }


@router.post("/api/integrations/helius/keys")
def add_helius_key(body: HeliusKeyBody, request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
    store = _store(request, require_configured=True)
    try:
        row = store.add("helius", "api_key", body.name.strip(), body.api_key, admin["sub"])
    except IntegrationSecretError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    _audit(request, admin, "helius_key_created", row["id"], {"name": row["name"]})
    return row


@router.patch("/api/integrations/helius/keys/{key_id}")
def update_helius_key(key_id: str, body: IntegrationEnabledBody, request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
    store = _store(request, require_configured=True)
    row = store.set_enabled(key_id, body.enabled, admin["sub"])
    if row is None or row.get("provider") != "helius" or row.get("kind") != "api_key":
        raise HTTPException(status_code=404, detail="Helius key not found")
    _audit(request, admin, "helius_key_enabled" if body.enabled else "helius_key_disabled", key_id)
    return row


@router.delete("/api/integrations/helius/keys/{key_id}")
def delete_helius_key(key_id: str, request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
    store = _store(request, require_configured=True)
    existing = next((row for row in store.list("helius", "api_key") if row["id"] == key_id), None)
    if existing is None or not store.delete(key_id):
        raise HTTPException(status_code=404, detail="Helius key not found")
    _audit(request, admin, "helius_key_deleted", key_id, {"name": existing["name"]})
    return {"ok": True}


@router.post("/api/integrations/helius/keys/{key_id}/test")
async def test_helius_key(key_id: str, request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
    store = _store(request, require_configured=True)
    key = store.get_plain(key_id)
    existing = next((row for row in store.list("helius", "api_key") if row["id"] == key_id), None)
    if not key or existing is None:
        raise HTTPException(status_code=404, detail="Helius key not found")

    checked_at = datetime.now(timezone.utc).isoformat()
    started = time.monotonic()
    ok = False
    error = None
    try:
        url = f"https://mainnet.helius-rpc.com/?api-key={key}"
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(url, json={"jsonrpc": "2.0", "id": 1, "method": "getHealth"})
            payload = response.json() if response.content else {}
            ok = response.is_success and payload.get("result") == "ok"
            if not ok:
                error = f"Helius HTTP {response.status_code}" if not response.is_success else "Helius health check failed"
    except (httpx.HTTPError, ValueError):
        error = "Helius request failed"
    latency_ms = round((time.monotonic() - started) * 1000)
    store.update_metadata(
        key_id,
        {"last_test_ok": ok, "last_test_at": checked_at, "last_test_latency_ms": latency_ms, "last_test_error": error},
        admin["sub"],
    )
    _audit(request, admin, "helius_key_tested", key_id, {"ok": ok, "latency_ms": latency_ms}, success=ok)
    return {"ok": ok, "checked_at": checked_at, "latency_ms": latency_ms, "error": error}


@router.put("/api/integrations/telegram/credentials")
def save_telegram_credentials(body: TelegramCredentialsBody, request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
    store = _store(request, require_configured=True)
    try:
        store.upsert_singleton("telegram", "api_id", "Telegram API ID", str(body.api_id), admin["sub"])
        store.upsert_singleton("telegram", "api_hash", "Telegram API Hash", body.api_hash, admin["sub"])
    except IntegrationSecretError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    _audit(request, admin, "telegram_credentials_updated", "telegram")
    return _telegram_summary(store)


@router.delete("/api/integrations/telegram/credentials")
def delete_telegram_credentials(request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
    store = _store(request, require_configured=True)
    deleted = store.delete_provider_kinds("telegram", ["api_id", "api_hash"])
    _audit(request, admin, "telegram_credentials_deleted", "telegram", {"deleted": deleted})
    return {"ok": True, "deleted": deleted}


@router.put("/api/integrations/telegram/session")
def save_telegram_session(body: TelegramSessionBody, request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
    store = _store(request, require_configured=True)
    try:
        store.upsert_singleton("telegram", "session_string", "Telegram Session", body.session_string, admin["sub"])
    except IntegrationSecretError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    _audit(request, admin, "telegram_session_updated", "telegram")
    return _telegram_summary(store)


@router.delete("/api/integrations/telegram/session")
def delete_telegram_session(request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
    store = _store(request, require_configured=True)
    deleted = store.delete_provider_kinds("telegram", ["session_string"])
    _audit(request, admin, "telegram_session_deleted", "telegram", {"deleted": deleted})
    return {"ok": True, "deleted": deleted}


@router.get("/internal/integrations/helius")
def internal_helius(request: Request) -> dict[str, Any]:
    _require_internal_service(request)
    store = _store(request, require_configured=True)
    try:
        keys = store.active_values("helius", "api_key")
    except IntegrationSecretError:
        raise HTTPException(status_code=503, detail="Integration secret storage unavailable") from None
    return {"keys": keys, "count": len(keys)}


@router.get("/internal/integrations/telegram")
def internal_telegram(request: Request) -> dict[str, Any]:
    _require_internal_service(request)
    store = _store(request, require_configured=True)
    try:
        api_id_raw = store.singleton_value("telegram", "api_id")
        api_hash = store.singleton_value("telegram", "api_hash")
        session_string = store.singleton_value("telegram", "session_string")
    except IntegrationSecretError:
        raise HTTPException(status_code=503, detail="Integration secret storage unavailable") from None
    try:
        api_id = int(api_id_raw) if api_id_raw else None
    except ValueError:
        api_id = None
    return {
        "api_id": api_id,
        "api_hash": api_hash or "",
        "session_string": session_string or "",
        "credentials_configured": bool(api_id and api_hash),
        "session_configured": bool(session_string),
    }
