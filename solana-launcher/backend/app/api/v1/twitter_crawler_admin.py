from __future__ import annotations

import hmac
import os
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.twitter_crawler_settings import TwitterCrawlerSettings

router = APIRouter()

SETTING_FIELDS = (
    "enabled",
    "query_limit",
    "process_limit",
    "batch_size",
    "max_depth",
    "min_relevance",
    "network_mode",
    "network_limit",
    "lease_seconds",
    "rescore_limit",
    "public_enabled",
    "public_dexscreener_latest",
    "public_dexscreener_boosts",
    "public_db_solana_tokens",
    "public_cmc_limit",
    "public_rescore_limit",
)


class TwitterCrawlerSettingsUpdate(BaseModel):
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


def _require_admin_key(supplied: str | None) -> None:
    expected = os.getenv("TWITTER_CRAWLER_ADMIN_KEY", "").strip()
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="TWITTER_CRAWLER_ADMIN_KEY is not configured",
        )
    if not supplied or not hmac.compare_digest(supplied, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Twitter crawler admin key",
        )


def _setting_columns() -> list:
    columns = [TwitterCrawlerSettings.id]
    columns.extend(getattr(TwitterCrawlerSettings, field) for field in SETTING_FIELDS)
    columns.append(TwitterCrawlerSettings.updated_at)
    return columns


def _serialize(row: dict) -> dict:
    result = dict(row)
    updated_at = result.get("updated_at")
    if isinstance(updated_at, datetime):
        result["updated_at"] = updated_at.isoformat()
    return result


@router.get("/crawler-settings/access")
async def crawler_settings_access(
    x_twitter_crawler_admin_key: str | None = Header(
        default=None,
        alias="X-Twitter-Crawler-Admin-Key",
    ),
) -> dict:
    _require_admin_key(x_twitter_crawler_admin_key)
    return {"ok": True, "scope": "twitter_crawler_settings"}


@router.get("/crawler-settings")
async def get_crawler_settings(
    session: AsyncSession = Depends(get_db),
    x_twitter_crawler_admin_key: str | None = Header(
        default=None,
        alias="X-Twitter-Crawler-Admin-Key",
    ),
) -> dict:
    _require_admin_key(x_twitter_crawler_admin_key)
    result = await session.execute(
        select(*_setting_columns()).where(TwitterCrawlerSettings.id == 1)
    )
    row = result.mappings().one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Twitter crawler settings are not initialized",
        )
    return {"ok": True, "settings": _serialize(dict(row))}


@router.put("/crawler-settings")
async def update_crawler_settings(
    body: TwitterCrawlerSettingsUpdate,
    session: AsyncSession = Depends(get_db),
    x_twitter_crawler_admin_key: str | None = Header(
        default=None,
        alias="X-Twitter-Crawler-Admin-Key",
    ),
) -> dict:
    _require_admin_key(x_twitter_crawler_admin_key)

    values = body.model_dump(exclude={"expected_updated_at"})
    values["updated_at"] = func.now()
    statement = (
        update(TwitterCrawlerSettings)
        .where(
            TwitterCrawlerSettings.id == 1,
            TwitterCrawlerSettings.updated_at == body.expected_updated_at,
        )
        .values(**values)
        .returning(*_setting_columns())
    )
    result = await session.execute(statement)
    row = result.mappings().one_or_none()
    if row is None:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Twitter settings changed in another session; refresh and retry",
        )

    await session.commit()
    return {"ok": True, "settings": _serialize(dict(row))}
