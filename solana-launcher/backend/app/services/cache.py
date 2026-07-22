from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from redis.asyncio import Redis

from app.core.config import Settings, get_settings


@lru_cache(maxsize=1)
def get_redis_client() -> Redis:
    settings: Settings = get_settings()
    return Redis.from_url(
        settings.redis_url,
        db=settings.redis_cache_db,
        decode_responses=True,
    )


async def cache_json(key: str, value: Any, ttl_seconds: int) -> None:
    client = get_redis_client()
    await client.set(key, json.dumps(value, default=str), ex=ttl_seconds)


async def read_json_cache(key: str) -> Any | None:
    client = get_redis_client()
    raw = await client.get(key)
    if raw is None:
        return None
    return json.loads(raw)


async def delete_cache(key: str) -> None:
    client = get_redis_client()
    await client.delete(key)
