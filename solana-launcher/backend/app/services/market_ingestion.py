from __future__ import annotations

import asyncio
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import noload

from app.core.config import Settings, get_settings
from app.models.analytics import Token, TokenMetric, TokenStatus
from app.services.cache import cache_json, read_json_cache
from app.services.etl import (
    TokenSourcePayload,
    fetch_social_links_from_source,
    upsert_token,
)
from app.services.observability import TOKENS_PROCESSED

BIRDEYE_REQUEST_CONCURRENCY = 12
BIRDEYE_TOKEN_BATCH_SIZE = 100
BIRDEYE_TIMEOUT_SECONDS = 20.0


async def _safe_cache_read(key: str) -> Any | None:
    try:
        return await read_json_cache(key)
    except Exception:
        # Cache availability must not stop the collector from refreshing durable data.
        return None


async def _safe_cache_write(key: str, value: Any, ttl_seconds: int) -> None:
    try:
        await cache_json(key, value, ttl_seconds=ttl_seconds)
    except Exception:
        # Redis is an optimization on this path; PostgreSQL remains the source of truth.
        return


async def _request_json(
    client: httpx.AsyncClient,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    semaphore: asyncio.Semaphore | None = None,
) -> Any:
    if semaphore is None:
        response = await client.get(url, headers=headers)
    else:
        async with semaphore:
            response = await client.get(url, headers=headers)
    response.raise_for_status()
    return response.json()


def _parse_datetime(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


async def fetch_pumpfun_tokens(
    client: httpx.AsyncClient,
    settings: Settings | None = None,
) -> list[TokenSourcePayload]:
    settings = settings or get_settings()
    cache_key = "pumpfun:tokens:active"
    cached = await _safe_cache_read(cache_key)
    if cached is not None:
        return [TokenSourcePayload(**item) for item in cached]

    url = f"{settings.pumpfun_api_base.rstrip('/')}/coins"
    payload = await _request_json(client, url)
    rows = payload if isinstance(payload, list) else payload.get("coins", [])
    tokens: list[TokenSourcePayload] = []
    for item in rows:
        mint = item.get("mint") or item.get("mintAddress") or item.get("address")
        if not mint:
            continue
        migrated = bool(item.get("migrated") or item.get("isMigrated"))
        tokens.append(
            TokenSourcePayload(
                mint_address=mint,
                name=item.get("name"),
                symbol=item.get("symbol") or item.get("ticker"),
                description=item.get("description"),
                creator_wallet=item.get("creator") or item.get("creatorWallet"),
                creation_date=_parse_datetime(
                    item.get("createdAt") or item.get("creationDate")
                ),
                migrated_to_raydium=migrated,
                migration_date=_parse_datetime(item.get("migrationDate")),
                status=(
                    TokenStatus.MIGRATED.value
                    if migrated
                    else TokenStatus.ACTIVE.value
                ),
            )
        )
    # TokenSourcePayload is a slotted dataclass, so use asdict rather than __dict__.
    await _safe_cache_write(
        cache_key,
        [asdict(item) for item in tokens],
        ttl_seconds=60,
    )
    return tokens


async def sync_pumpfun_tokens(
    session: AsyncSession,
    settings: Settings | None = None,
) -> int:
    settings = settings or get_settings()
    async with httpx.AsyncClient(timeout=BIRDEYE_TIMEOUT_SECONDS) as client:
        tokens = await fetch_pumpfun_tokens(client, settings)

    count = 0
    for payload in tokens:
        await upsert_token(session, payload)
        count += 1
    TOKENS_PROCESSED.inc(count)
    return count


async def fetch_birdeye_metrics(
    client: httpx.AsyncClient,
    mint_address: str,
    settings: Settings,
    semaphore: asyncio.Semaphore,
) -> dict[str, Any]:
    cache_key = f"birdeye:metrics:{mint_address}"
    cached = await _safe_cache_read(cache_key)
    if cached is not None:
        return dict(cached)

    headers = (
        {"X-API-KEY": settings.birdeye_api_key}
        if settings.birdeye_api_key
        else None
    )
    base = settings.birdeye_api_base.rstrip("/")
    urls = {
        "price": f"{base}/defi/price?address={mint_address}",
        "ohlcv": f"{base}/defi/ohlcv?address={mint_address}&type=1H",
        "holders": f"{base}/token/holder?address={mint_address}",
    }

    async def fetch_component(key: str, url: str) -> tuple[str, Any]:
        try:
            payload = await _request_json(
                client,
                url,
                headers=headers,
                semaphore=semaphore,
            )
        except Exception as exc:  # pragma: no cover - provider/network failure path
            payload = {"error": str(exc)}
        return key, payload

    components = await asyncio.gather(
        *(fetch_component(key, url) for key, url in urls.items())
    )
    result = dict(components)
    await _safe_cache_write(cache_key, result, ttl_seconds=60)
    return result


def _to_float(value: Any) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _to_int(value: Any) -> int | None:
    try:
        return None if value is None else int(float(value))
    except (TypeError, ValueError):
        return None


def _deep_find(payload: Any, keys: set[str]) -> Any:
    if isinstance(payload, dict):
        for key in keys:
            if key in payload and payload[key] is not None:
                return payload[key]
        for value in payload.values():
            found = _deep_find(value, keys)
            if found is not None:
                return found
    elif isinstance(payload, list):
        for value in payload:
            found = _deep_find(value, keys)
            if found is not None:
                return found
    return None


def _metric_values(
    metrics: dict[str, Any],
    social_links: dict[str, str | None],
) -> dict[str, Any]:
    price_payload = metrics.get("price", {})
    price_data = price_payload.get("data") if isinstance(price_payload, dict) else None
    price_value = None
    if isinstance(price_data, dict):
        price_value = (
            price_data.get("value")
            or price_data.get("price")
            or price_data.get("priceUsd")
        )
    if price_value is None:
        price_value = _deep_find(price_payload, {"value", "price", "priceUsd"})

    now = datetime.now(timezone.utc)
    return {
        "timestamp": now,
        "price_usd": _to_float(price_value),
        "ath_usd": _to_float(price_value),
        "ath_date": now,
        "market_cap": _to_float(
            _deep_find(metrics, {"marketCap", "market_cap"})
        ),
        "fdv": _to_float(
            _deep_find(metrics, {"fdv", "fullyDilutedValuation"})
        ),
        "liquidity_usd": _to_float(
            _deep_find(metrics, {"liquidity", "liquidityUsd"})
        ),
        "volume_24h": _to_float(
            _deep_find(metrics, {"volume24h", "volume_24h"})
        ),
        "tx_count_24h": _to_int(
            _deep_find(metrics, {"txCount24h", "tx_count_24h"})
        ),
        "holder_count": _to_int(
            _deep_find(metrics, {"holderCount", "holder_count"})
        ),
        "twitter_url": social_links.get("twitter_url"),
        "telegram_url": social_links.get("telegram_url"),
        "discord_url": social_links.get("discord_url"),
        "website_url": social_links.get("website_url"),
        "social_engagements": metrics,
    }


async def _safe_social_links(
    mint_address: str,
    settings: Settings,
) -> dict[str, str | None]:
    try:
        return await fetch_social_links_from_source(mint_address, settings)
    except Exception:
        return {
            "twitter_url": None,
            "telegram_url": None,
            "discord_url": None,
            "website_url": None,
        }


async def _fetch_token_observation(
    client: httpx.AsyncClient,
    token: Token,
    settings: Settings,
    semaphore: asyncio.Semaphore,
) -> tuple[int, dict[str, Any], dict[str, str | None]]:
    metrics, social_links = await asyncio.gather(
        fetch_birdeye_metrics(client, token.mint_address, settings, semaphore),
        _safe_social_links(token.mint_address, settings),
    )
    return token.id, metrics, social_links


async def sync_metrics_for_active_tokens(
    session: AsyncSession,
    settings: Settings | None = None,
    *,
    request_concurrency: int = BIRDEYE_REQUEST_CONCURRENCY,
    token_batch_size: int = BIRDEYE_TOKEN_BATCH_SIZE,
) -> int:
    """Refresh token metrics with bounded provider concurrency and batched DB flushes.

    Network I/O is concurrent, but all writes stay on the caller's AsyncSession and are
    performed sequentially per batch. This avoids concurrent AsyncSession use while
    eliminating the old token-by-token/provider-by-provider request waterfall.
    """
    settings = settings or get_settings()
    concurrency = max(1, min(int(request_concurrency), 64))
    batch_size = max(1, min(int(token_batch_size), 1000))

    result = await session.execute(
        select(Token)
        .options(noload(Token.metrics), noload(Token.trades))
        .where(Token.status == TokenStatus.ACTIVE.value)
        .order_by(Token.id.asc())
    )
    tokens = list(result.scalars().all())
    if not tokens:
        return 0

    semaphore = asyncio.Semaphore(concurrency)
    limits = httpx.Limits(
        max_connections=concurrency,
        max_keepalive_connections=concurrency,
    )
    timeout = httpx.Timeout(BIRDEYE_TIMEOUT_SECONDS)
    count = 0

    async with httpx.AsyncClient(timeout=timeout, limits=limits) as client:
        for start in range(0, len(tokens), batch_size):
            batch = tokens[start : start + batch_size]
            observations = await asyncio.gather(
                *(
                    _fetch_token_observation(client, token, settings, semaphore)
                    for token in batch
                )
            )
            metric_rows = [
                TokenMetric(
                    token_id=token_id,
                    **_metric_values(metrics, social_links),
                )
                for token_id, metrics, social_links in observations
            ]
            session.add_all(metric_rows)
            # One flush per batch also updates token_latest_metrics via its ORM hook.
            await session.flush()
            count += len(metric_rows)

    TOKENS_PROCESSED.inc(count)
    return count
