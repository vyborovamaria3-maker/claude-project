from __future__ import annotations

import asyncio

from redis import Redis
from redis.exceptions import LockError, RedisError

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.kol_metrics import refresh_kol_metrics
from app.services.kol_trade_ingestion import sync_kol_trade_events
from app.tasks.celery_app import celery_app

_REFRESH_LOCK_KEY = "potapoff:kols:refresh_metrics"
_REFRESH_LOCK_TTL_SECONDS = 1800
_TRADE_SYNC_LOCK_KEY = "potapoff:kols:sync_trade_events"
_TRADE_SYNC_LOCK_TTL_SECONDS = 900


async def _run_refresh() -> dict[str, int]:
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    async with sessionmaker() as session:
        try:
            result = await refresh_kol_metrics(session)
            await session.commit()
            return result
        except Exception:
            await session.rollback()
            raise
        finally:
            await engine.dispose()


async def _run_trade_sync() -> dict[str, int | str]:
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    async with sessionmaker() as session:
        try:
            result = await sync_kol_trade_events(session)
            await session.commit()
            return result
        except Exception:
            await session.rollback()
            raise
        finally:
            await engine.dispose()


def _with_redis_lock(lock_key: str, ttl_seconds: int, runner):
    settings = get_settings()
    redis_client = Redis.from_url(
        settings.redis_url,
        socket_connect_timeout=2,
        socket_timeout=2,
    )
    lock = redis_client.lock(
        lock_key,
        timeout=ttl_seconds,
        blocking_timeout=0,
    )
    acquired = False
    try:
        try:
            acquired = bool(lock.acquire(blocking=False))
        except RedisError:
            return {"skipped": 1}
        if not acquired:
            return {"skipped": 1}
        return runner()
    finally:
        if acquired:
            try:
                lock.release()
            except (LockError, RedisError):
                pass
        try:
            redis_client.close()
        except RedisError:
            pass


@celery_app.task(name="app.tasks.kols.refresh_metrics")
def refresh_metrics() -> dict[str, int]:
    """Refresh KOL metrics once across all workers.

    Celery Beat fires frequently, while a refresh can become slower as the event
    history grows. A Redis lock prevents overlapping workers from overwriting a
    newer calculation. The TTL releases a lock after a crashed worker.
    """
    result = _with_redis_lock(
        _REFRESH_LOCK_KEY,
        _REFRESH_LOCK_TTL_SECONDS,
        lambda: asyncio.run(_run_refresh()),
    )
    if result.get("skipped"):
        return {"wallets": 0, "metrics": 0, "skipped": 1}
    return {
        "wallets": int(result.get("wallets", 0)),
        "metrics": int(result.get("metrics", 0)),
    }


@celery_app.task(name="app.tasks.kols.sync_trade_events")
def sync_trade_events() -> dict[str, int | str]:
    """Rotate through attributed Solana wallets and ingest recent swap events.

    The provider budget is intentionally conservative by default. The service
    chooses the least-recently-synced wallet(s), while the unique event key keeps
    retries idempotent. Missing SOLANA_TRACKER_API_KEY returns a disabled status
    instead of crashing Celery.
    """
    result = _with_redis_lock(
        _TRADE_SYNC_LOCK_KEY,
        _TRADE_SYNC_LOCK_TTL_SECONDS,
        lambda: asyncio.run(_run_trade_sync()),
    )
    if result.get("skipped"):
        return {"wallets": 0, "events": 0, "failures": 0, "status": "skipped", "skipped": 1}
    return result
