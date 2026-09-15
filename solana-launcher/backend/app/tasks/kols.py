from __future__ import annotations

import asyncio

from redis import Redis
from redis.exceptions import LockError, RedisError

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.kol_metrics import refresh_kol_metrics
from app.tasks.celery_app import celery_app

_REFRESH_LOCK_KEY = "potapoff:kols:refresh_metrics"
_REFRESH_LOCK_TTL_SECONDS = 1800


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


@celery_app.task(name="app.tasks.kols.refresh_metrics")
def refresh_metrics() -> dict[str, int]:
    """Refresh KOL metrics once across all workers.

    Celery Beat fires every five minutes, while a refresh can become slower as the
    wallet history grows. A Redis lock prevents two workers/runs from updating the
    same metric windows concurrently. The TTL releases a lock after a crashed worker.
    """
    settings = get_settings()
    redis_client = Redis.from_url(
        settings.redis_url,
        socket_connect_timeout=2,
        socket_timeout=2,
    )
    lock = redis_client.lock(
        _REFRESH_LOCK_KEY,
        timeout=_REFRESH_LOCK_TTL_SECONDS,
        blocking_timeout=0,
    )
    acquired = False
    try:
        try:
            acquired = bool(lock.acquire(blocking=False))
        except RedisError:
            # The result backend also depends on Redis. Fail closed rather than run
            # an uncoordinated refresh that could overwrite a newer calculation.
            return {"wallets": 0, "metrics": 0, "skipped": 1}
        if not acquired:
            return {"wallets": 0, "metrics": 0, "skipped": 1}
        return asyncio.run(_run_refresh())
    finally:
        if acquired:
            try:
                lock.release()
            except (LockError, RedisError):
                # A TTL-expired/lost lock must never turn a completed metric refresh
                # into a failed Celery task.
                pass
        try:
            redis_client.close()
        except RedisError:
            pass
