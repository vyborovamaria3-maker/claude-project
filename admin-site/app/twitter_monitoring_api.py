from __future__ import annotations

import ipaddress
import logging
import os
from datetime import datetime
from typing import Literal

import httpx
import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .auth import require_admin
from .twitter_monitoring import TwitterMonitoringStore, find_twitter_source

logger = logging.getLogger(__name__)


class TwitterCrawlerSettingsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_updated_at: datetime
    enabled: bool
    query_limit: int = Field(ge=10, le=100)
    process_limit: int = Field(ge=1, le=5000)
    batch_size: int = Field(ge=1, le=250)
    max_depth: int = Field(ge=0, le=8)
    min_relevance: float = Field(ge=0.0, le=100.0, allow_inf_nan=False)
    network_mode: Literal["none", "following", "followers", "both"]
    network_limit: int = Field(ge=1, le=1000)
    lease_seconds: int = Field(ge=30, le=3600)
    rescore_limit: int = Field(ge=1, le=5000)
    public_enabled: bool
    public_dexscreener_latest: bool
    public_dexscreener_boosts: bool
    public_db_solana_tokens: int = Field(ge=0, le=10000)
    public_cmc_limit: int = Field(ge=0, le=5000)
    public_rescore_limit: int = Field(ge=0, le=5000)

    @field_validator("expected_updated_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("expected_updated_at must include a timezone")
        return value


def _store(request: Request) -> TwitterMonitoringStore:
    try:
        source = find_twitter_source(request.app.state.registry)
        return TwitterMonitoringStore(source)
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None


def _audit_ip(request: Request) -> str:
    settings = request.app.state.settings
    direct = request.client.host if request.client else "unknown"
    if not settings.trust_proxy:
        return direct
    values = [
        item.strip()
        for item in request.headers.get("x-forwarded-for", "").split(",")
        if item.strip()
    ]
    if not values:
        return direct
    index = len(values) - settings.trusted_proxy_hops - 1
    if index < 0:
        return direct
    candidate = values[index]
    try:
        ipaddress.ip_address(candidate)
        return candidate
    except ValueError:
        return direct


def _audit_settings_update(
    request: Request,
    *,
    username: str,
    success: bool,
    details: dict,
) -> None:
    try:
        request.app.state.audit.record(
            action="twitter_crawler_settings_update",
            success=success,
            username=username,
            ip_address=_audit_ip(request),
            resource="twitter_crawler_settings:1",
            details=details,
        )
    except Exception:
        logger.exception(
            "Could not persist Twitter crawler settings audit event success=%s",
            success,
        )


def _backend_settings_url() -> str:
    base = os.getenv("ADMIN_TWITTER_BACKEND_URL", "http://backend:8000").strip().rstrip("/")
    if not base:
        raise RuntimeError("ADMIN_TWITTER_BACKEND_URL is not configured")
    return f"{base}/api/v1/twitter/admin/crawler-settings"


def _update_via_backend(body: TwitterCrawlerSettingsBody) -> dict:
    key = os.getenv("TWITTER_CRAWLER_ADMIN_KEY", "").strip()
    if len(key) < 32:
        raise RuntimeError("TWITTER_CRAWLER_ADMIN_KEY is not configured")

    try:
        with httpx.Client(timeout=8.0, trust_env=False) as client:
            response = client.put(
                _backend_settings_url(),
                json=body.model_dump(mode="json"),
                headers={"X-Twitter-Crawler-Admin-Key": key},
            )
    except httpx.HTTPError as exc:
        raise RuntimeError(f"Twitter settings backend is unavailable: {exc}") from exc

    if response.status_code == 409:
        raise HTTPException(
            status_code=409,
            detail="Twitter settings changed in another session; refresh and retry",
        )
    if response.status_code != 200:
        logger.error(
            "Twitter settings backend rejected update status=%s body=%s",
            response.status_code,
            response.text[:400],
        )
        raise RuntimeError("Twitter settings backend rejected the update")

    payload = response.json()
    settings = payload.get("settings") if isinstance(payload, dict) else None
    if not isinstance(settings, dict):
        raise RuntimeError("Twitter settings backend returned an invalid response")
    return settings


def build_twitter_monitoring_router() -> APIRouter:
    router = APIRouter(prefix="/api/twitter-monitoring", tags=["twitter-monitoring"])

    @router.get("")
    def snapshot(request: Request, admin=Depends(require_admin)) -> dict:
        del admin
        try:
            return _store(request).snapshot()
        except (psycopg.Error, RuntimeError) as exc:
            raise HTTPException(status_code=503, detail=str(exc)[:400]) from None

    @router.put("/settings")
    def update_settings(
        body: TwitterCrawlerSettingsBody,
        request: Request,
        admin=Depends(require_admin),
    ) -> dict:
        values = body.model_dump(exclude={"expected_updated_at"})
        try:
            row = _update_via_backend(body)
        except HTTPException as exc:
            if exc.status_code == 409:
                _audit_settings_update(
                    request,
                    username=admin["sub"],
                    success=False,
                    details={"reason": "optimistic_lock_conflict"},
                )
            raise
        except (RuntimeError, ValueError) as exc:
            _audit_settings_update(
                request,
                username=admin["sub"],
                success=False,
                details={"error": str(exc)[:200]},
            )
            raise HTTPException(status_code=503, detail="Twitter settings update failed") from None

        _audit_settings_update(
            request,
            username=admin["sub"],
            success=True,
            details={"updated_fields": sorted(values)},
        )
        return {"ok": True, "settings": row}

    return router
