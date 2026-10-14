"""Redis quota atomicity and fail-closed behaviour in Telegram rate limits."""

from __future__ import annotations

import pytest

from app.core.rate_limit import RateLimiter, RateLimiterUnavailable


class FakeRedis:
    def __init__(self):
        self.count = 0
        self.commands = []

    async def eval(self, script, numkeys, key, window_seconds):
        self.commands.append((script, numkeys, key, window_seconds))
        self.count += 1
        return [self.count, window_seconds]


class BrokenRedis:
    async def eval(self, *_args):
        raise ConnectionError("redis offline")


@pytest.mark.asyncio
async def test_shared_quota_uses_atomic_redis_script():
    fake = FakeRedis()
    limiter = RateLimiter(fake)
    assert (await limiter.allow("owner:A", limit=2, window_seconds=60)).allowed
    assert (await limiter.allow("owner:A", limit=2, window_seconds=60)).allowed
    third = await limiter.allow("owner:A", limit=2, window_seconds=60)
    assert not third.allowed
    assert third.remaining == 0
    assert len(fake.commands) == 3
    assert all("EXPIRE" in row[0] and "INCR" in row[0] for row in fake.commands)
    assert all(row[1:] == (1, "owner:A", 60) for row in fake.commands)


@pytest.mark.asyncio
async def test_sensitive_shared_quota_fails_closed_when_redis_is_offline():
    limiter = RateLimiter(BrokenRedis())
    with pytest.raises(RateLimiterUnavailable):
        await limiter.allow("tginvite-read:owner", limit=2, window_seconds=60, require_shared=True)
