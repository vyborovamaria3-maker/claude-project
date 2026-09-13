from __future__ import annotations

import ipaddress
import logging
from datetime import datetime
from typing import Literal

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
        # Audit persistence is valuable, but it must not make the already-known
        # outcome of the settings transaction ambiguous to the operator.
        logger.exception(
            "Could not persist Twitter crawler settings audit event success=%s",
            success,
        )


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
        store = _store(request)
        try:
            row = store.update_settings(
                values,
                expected_updated_at=body.expected_updated_at,
            )
        except (psycopg.Error, ValueError) as exc:
            _audit_settings_update(
                request,
                username=admin["sub"],
                success=False,
                details={"error": str(exc)[:200]},
            )
            raise HTTPException(status_code=503, detail="Twitter settings update failed") from None

        if row is None:
            _audit_settings_update(
                request,
                username=admin["sub"],
                success=False,
                details={"reason": "optimistic_lock_conflict"},
            )
            raise HTTPException(
                status_code=409,
                detail="Twitter settings changed in another session; refresh and retry",
            )

        _audit_settings_update(
            request,
            username=admin["sub"],
            success=True,
            details={"updated_fields": sorted(values)},
        )
        return {"ok": True, "settings": row}

    return router
