from __future__ import annotations

import asyncio
import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.cache import cache_json, get_redis_client, read_json_cache
from app.services.observability import ANALYSIS_CACHE_REQUESTS, ANALYSIS_STAGE_RUNTIME
from app.services.telegram_signal_analysis import caller_reputation

_CACHE_KEY = "telegram:caller-reputation:v3:top250"
_LOCK_KEY = f"{_CACHE_KEY}:lock"
_CACHE_TTL_SECONDS = 180
_LOCK_TTL_SECONDS = 90
_WAIT_SECONDS = 15.0
_POLL_SECONDS = 0.15
_RELEASE_LOCK_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
end
return 0
"""


def _cached_rows(value: Any) -> list[dict[str, Any]] | None:
    if not isinstance(value, list):
        return None
    if not all(isinstance(row, dict) for row in value):
        return None
    return [dict(row) for row in value]


async def _safe_read() -> list[dict[str, Any]] | None:
    try:
        return _cached_rows(await read_json_cache(_CACHE_KEY))
    except Exception:
        return None


async def cached_top_callers(
    session: AsyncSession,
    *,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Serve the expensive global caller leaderboard from short-lived Redis state.

    One cached top-250 result serves every API limit. Redis is optional: cache or
    lock failure falls back to the durable PostgreSQL calculation.
    """
    safe_limit = max(1, min(int(limit), 250))
    cached = await _safe_read()
    if cached is not None:
        ANALYSIS_CACHE_REQUESTS.labels(
            layer="telegram_caller_reputation",
            result="hit",
        ).inc()
        return cached[:safe_limit]

    ANALYSIS_CACHE_REQUESTS.labels(
        layer="telegram_caller_reputation",
        result="miss",
    ).inc()
    owner = uuid.uuid4().hex
    acquired = False
    client = None
    try:
        client = get_redis_client()
        acquired = bool(
            await client.set(
                _LOCK_KEY,
                owner,
                nx=True,
                ex=_LOCK_TTL_SECONDS,
            )
        )
    except Exception:
        client = None

    if not acquired and client is not None:
        deadline = asyncio.get_running_loop().time() + _WAIT_SECONDS
        while asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(_POLL_SECONDS)
            cached = await _safe_read()
            if cached is not None:
                ANALYSIS_CACHE_REQUESTS.labels(
                    layer="telegram_caller_reputation",
                    result="wait_hit",
                ).inc()
                return cached[:safe_limit]
        ANALYSIS_CACHE_REQUESTS.labels(
            layer="telegram_caller_reputation",
            result="wait_timeout",
        ).inc()

    try:
        with ANALYSIS_STAGE_RUNTIME.labels(stage="caller_reputation").time():
            rows = await caller_reputation(session, limit=250)
        try:
            await cache_json(_CACHE_KEY, rows, _CACHE_TTL_SECONDS)
        except Exception:
            pass
        return rows[:safe_limit]
    finally:
        if acquired and client is not None:
            try:
                await client.eval(
                    _RELEASE_LOCK_SCRIPT,
                    1,
                    _LOCK_KEY,
                    owner,
                )
            except Exception:
                pass
