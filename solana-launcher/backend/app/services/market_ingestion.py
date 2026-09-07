from __future__ import annotations

import asyncio
import random
from dataclasses import asdict
from datetime import datetime, timezone
from time import monotonic
from typing import Any, Iterable

import httpx
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
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
from app.services.observability import (
    INGESTION_BATCH_RUNTIME,
    PROVIDER_RATE_LIMITS,
    PROVIDER_REQUEST_LATENCY,
    PROVIDER_REQUESTS,
    PROVIDER_RETRIES,
    TOKENS_PROCESSED,
)

PUMPFUN_TIMEOUT_SECONDS = 20.0
RETRYABLE_STATUS_CODES = frozenset({429, 500, 502, 503, 504})


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


def _retry_after_seconds(response: Any) -> float | None:
    headers = getattr(response, "headers", None)
    if not headers:
        return None
    raw = headers.get("Retry-After")
    if raw in (None, ""):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return max(0.0, value)


def _retry_delay(
    settings: Settings,
    attempt: int,
    response: Any | None = None,
) -> float:
    retry_after = _retry_after_seconds(response) if response is not None else None
    if retry_after is not None:
        return min(retry_after, settings.birdeye_backoff_max_seconds)

    exponential = settings.birdeye_backoff_base_seconds * (2**attempt)
    bounded = min(exponential, settings.birdeye_backoff_max_seconds)
    jitter_ceiling = min(settings.birdeye_backoff_base_seconds, bounded * 0.25)
    jitter = random.uniform(0.0, jitter_ceiling) if jitter_ceiling > 0 else 0.0
    return min(bounded + jitter, settings.birdeye_backoff_max_seconds)


def _observe_attempt(
    *,
    provider: str | None,
    operation: str | None,
    result: str,
    elapsed: float,
) -> None:
    if not provider or not operation:
        return
    PROVIDER_REQUESTS.labels(
        provider=provider,
        operation=operation,
        result=result,
    ).inc()
    PROVIDER_REQUEST_LATENCY.labels(
        provider=provider,
        operation=operation,
    ).observe(elapsed)


async def _request_json(
    client: httpx.AsyncClient,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    semaphore: asyncio.Semaphore | None = None,
    retry_settings: Settings | None = None,
    provider: str | None = None,
    operation: str | None = None,
) -> Any:
    retries = retry_settings.birdeye_max_retries if retry_settings is not None else 0

    for attempt in range(retries + 1):
        response = None
        started = monotonic()
        try:
            if semaphore is None:
                response = await client.get(url, headers=headers)
            else:
                # Hold a concurrency slot only for the actual network request. A request
                # sleeping in backoff must not block unrelated tokens from progressing.
                async with semaphore:
                    response = await client.get(url, headers=headers)
        except httpx.RequestError:
            _observe_attempt(
                provider=provider,
                operation=operation,
                result="transport_error",
                elapsed=monotonic() - started,
            )
            if retry_settings is None or attempt >= retries:
                raise
            if provider and operation:
                PROVIDER_RETRIES.labels(
                    provider=provider,
                    operation=operation,
                    reason="transport_error",
                ).inc()
            await asyncio.sleep(_retry_delay(retry_settings, attempt))
            continue

        status_code = int(getattr(response, "status_code", 200) or 200)
        _observe_attempt(
            provider=provider,
            operation=operation,
            result=str(status_code),
            elapsed=monotonic() - started,
        )
        if status_code == 429 and provider and operation:
            PROVIDER_RATE_LIMITS.labels(
                provider=provider,
                operation=operation,
            ).inc()

        if (
            retry_settings is not None
            and status_code in RETRYABLE_STATUS_CODES
            and attempt < retries
        ):
            if provider and operation:
                PROVIDER_RETRIES.labels(
                    provider=provider,
                    operation=operation,
                    reason=str(status_code),
                ).inc()
            await asyncio.sleep(_retry_delay(retry_settings, attempt, response))
            continue

        response.raise_for_status()
        return response.json()

    raise RuntimeError("provider request retry loop exhausted")


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
    payload = await _request_json(
        client,
        url,
        provider="pumpfun",
        operation="tokens",
    )
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


def _deduplicate_token_payloads(
    payloads: Iterable[TokenSourcePayload],
) -> list[TokenSourcePayload]:
    by_mint: dict[str, TokenSourcePayload] = {}
    for payload in payloads:
        if payload.mint_address:
            by_mint[payload.mint_address] = payload
    return list(by_mint.values())


async def _bulk_upsert_pumpfun_tokens(
    session: AsyncSession,
    payloads: Iterable[TokenSourcePayload],
) -> int:
    """Use one PostgreSQL INSERT..ON CONFLICT statement for a Pump.fun refresh.

    Tests use SQLite, so a small compatibility fallback keeps the same behavior there.
    Production PostgreSQL avoids the previous SELECT + INSERT/UPDATE round trip per token.
    """
    deduplicated = _deduplicate_token_payloads(payloads)
    if not deduplicated:
        return 0

    if session.get_bind().dialect.name != "postgresql":
        for payload in deduplicated:
            await upsert_token(session, payload)
        return len(deduplicated)

    now = datetime.now(timezone.utc)
    values = [
        {
            "mint_address": payload.mint_address,
            "name": payload.name,
            "symbol": payload.symbol,
            "description": payload.description,
            "creator_wallet": payload.creator_wallet,
            "creation_date": payload.creation_date,
            "migrated_to_raydium": payload.migrated_to_raydium,
            "migration_date": payload.migration_date,
            "status": payload.status,
            "last_synced_at": now,
        }
        for payload in deduplicated
    ]
    statement = pg_insert(Token).values(values)
    excluded = statement.excluded
    statement = statement.on_conflict_do_update(
        index_elements=[Token.mint_address],
        set_={
            # Preserve existing useful metadata when a provider omits it on a later scan.
            "name": func.coalesce(func.nullif(excluded.name, ""), Token.name),
            "symbol": func.coalesce(func.nullif(excluded.symbol, ""), Token.symbol),
            "description": func.coalesce(
                func.nullif(excluded.description, ""),
                Token.description,
            ),
            "creator_wallet": func.coalesce(
                func.nullif(excluded.creator_wallet, ""),
                Token.creator_wallet,
            ),
            "creation_date": func.coalesce(excluded.creation_date, Token.creation_date),
            "migrated_to_raydium": (
                Token.migrated_to_raydium | excluded.migrated_to_raydium
            ),
            "migration_date": func.coalesce(excluded.migration_date, Token.migration_date),
            "status": func.coalesce(func.nullif(excluded.status, ""), Token.status),
            "last_synced_at": excluded.last_synced_at,
        },
    )
    await session.execute(statement)
    return len(deduplicated)


async def sync_pumpfun_tokens(
    session: AsyncSession,
    settings: Settings | None = None,
) -> int:
    settings = settings or get_settings()
    with INGESTION_BATCH_RUNTIME.labels(provider="pumpfun").time():
        async with httpx.AsyncClient(timeout=PUMPFUN_TIMEOUT_SECONDS) as client:
            tokens = await fetch_pumpfun_tokens(client, settings)
        count = await _bulk_upsert_pumpfun_tokens(session, tokens)
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
                retry_settings=settings,
                provider="birdeye",
                operation=key,
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
    request_concurrency: int | None = None,
    token_batch_size: int | None = None,
) -> int:
    """Refresh token metrics with bounded provider concurrency and batched DB flushes.

    Network I/O is concurrent, but all writes stay on the caller's AsyncSession and are
    performed sequentially per batch. This avoids concurrent AsyncSession use while
    eliminating the old token-by-token/provider-by-provider request waterfall.
    """
    settings = settings or get_settings()
    concurrency = (
        settings.birdeye_request_concurrency
        if request_concurrency is None
        else max(1, min(int(request_concurrency), 64))
    )
    batch_size = (
        settings.birdeye_token_batch_size
        if token_batch_size is None
        else max(1, min(int(token_batch_size), 1000))
    )

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
    timeout = httpx.Timeout(settings.birdeye_timeout_seconds)
    count = 0

    async with httpx.AsyncClient(timeout=timeout, limits=limits) as client:
        for start in range(0, len(tokens), batch_size):
            batch = tokens[start : start + batch_size]
            with INGESTION_BATCH_RUNTIME.labels(provider="birdeye").time():
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
