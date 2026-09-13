from __future__ import annotations

from datetime import datetime
from typing import Literal

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .auth import require_admin
from .twitter_monitoring import TwitterMonitoringStore, find_twitter_source


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
            request.app.state.audit.record(
                action="twitter_crawler_settings_update",
                success=False,
                username=admin["sub"],
                ip_address=request.client.host if request.client else "unknown",
                resource="twitter_crawler_settings:1",
                details={"error": str(exc)[:200]},
            )
            raise HTTPException(status_code=503, detail="Twitter settings update failed") from None

        if row is None:
            request.app.state.audit.record(
                action="twitter_crawler_settings_update",
                success=False,
                username=admin["sub"],
                ip_address=request.client.host if request.client else "unknown",
                resource="twitter_crawler_settings:1",
                details={"reason": "optimistic_lock_conflict"},
            )
            raise HTTPException(
                status_code=409,
                detail="Twitter settings changed in another session; refresh and retry",
            )

        request.app.state.audit.record(
            action="twitter_crawler_settings_update",
            success=True,
            username=admin["sub"],
            ip_address=request.client.host if request.client else "unknown",
            resource="twitter_crawler_settings:1",
            details={"updated_fields": sorted(values)},
        )
        return {"ok": True, "settings": row}

    return router
