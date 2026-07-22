from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any

from redis.asyncio import Redis


@dataclass(slots=True)
class RateLimitResult:
    allowed: bool
    remaining: int
    retry_after: int


class RateLimiter:
    def __init__(self, redis_client: Redis[str] | None = None) -> None:
        self._redis = redis_client
        self._memory: dict[str, tuple[int, float]] = {}
        self._lock = asyncio.Lock()

    async def allow(self, key: str, *, limit: int, window_seconds: int) -> RateLimitResult:
        if self._redis is not None:
            try:
                return await self._allow_redis(key, limit=limit, window_seconds=window_seconds)
            except Exception:
                # Fall back to in-memory protection if Redis is temporarily unavailable.
                pass
        return await self._allow_memory(key, limit=limit, window_seconds=window_seconds)

    async def _allow_redis(self, key: str, *, limit: int, window_seconds: int) -> RateLimitResult:
        count = await self._redis.incr(key)
        if count == 1:
            await self._redis.expire(key, window_seconds)
        ttl = await self._redis.ttl(key)
        remaining = max(0, limit - count)
        retry_after = ttl if isinstance(ttl, int) and ttl > 0 else window_seconds
        return RateLimitResult(allowed=count <= limit, remaining=remaining, retry_after=retry_after)

    async def _allow_memory(self, key: str, *, limit: int, window_seconds: int) -> RateLimitResult:
        now = time.monotonic()
        async with self._lock:
            count, expires_at = self._memory.get(key, (0, 0.0))
            if now >= expires_at:
                count = 0
                expires_at = now + window_seconds
            count += 1
            self._memory[key] = (count, expires_at)
            remaining = max(0, limit - count)
            retry_after = max(1, int(expires_at - now))
            return RateLimitResult(allowed=count <= limit, remaining=remaining, retry_after=retry_after)


def make_limit_key(*parts: Any) -> str:
    return ":".join(str(part) for part in parts if part is not None and str(part))
