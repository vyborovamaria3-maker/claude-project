from __future__ import annotations

import os
from dataclasses import dataclass

import httpx


@dataclass(frozen=True)
class TelegramIntegrationSnapshot:
    api_id: int | None
    api_hash: str
    session_string: str
    credentials_configured: bool
    session_configured: bool


async def fetch_admin_telegram_integrations() -> tuple[TelegramIntegrationSnapshot | None, str | None]:
    """Read Telegram MTProto credentials from the scoped admin control-plane endpoint.

    The endpoint is optional: missing configuration or a transient admin failure
    leaves the backend's legacy environment credentials untouched.
    """
    base = os.getenv("ADMIN_INTEGRATIONS_BASE_URL", "").strip().rstrip("/")
    token = os.getenv("ADMIN_TELEGRAM_SERVICE_TOKEN", "").strip()
    if not base or len(token) < 32:
        return None, None

    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.get(
                f"{base}/internal/integrations/telegram",
                headers={
                    "Accept": "application/json",
                    "X-Integration-Service-Key": token,
                },
            )
        if response.status_code != 200:
            return None, f"admin integrations HTTP {response.status_code}"
        payload = response.json()
        api_id_raw = payload.get("api_id")
        try:
            api_id = int(api_id_raw) if api_id_raw else None
        except (TypeError, ValueError):
            api_id = None
        api_hash = str(payload.get("api_hash") or "").strip()
        session_string = str(payload.get("session_string") or "").strip()
        return TelegramIntegrationSnapshot(
            api_id=api_id,
            api_hash=api_hash,
            session_string=session_string,
            credentials_configured=bool(api_id and api_hash and payload.get("credentials_configured")),
            session_configured=bool(session_string and payload.get("session_configured")),
        ), None
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        return None, f"admin integrations unavailable: {type(exc).__name__}"
