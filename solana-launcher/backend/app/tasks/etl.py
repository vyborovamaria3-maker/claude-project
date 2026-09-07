from __future__ import annotations

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.collection import run_full_collection
from app.services.etl import get_or_create_jobs
from app.services.market_ingestion import (
    sync_metrics_for_active_tokens,
    sync_pumpfun_tokens,
)
from app.services.wallet_clusters import rebuild_wallet_links
from app.tasks.async_runtime import run_async_task
from app.tasks.celery_app import celery_app


async def _run_with_session(coro):
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    async with sessionmaker() as session:
        try:
            result = await coro(session)
            await session.commit()
            return result
        except Exception:
            await session.rollback()
            raise
        finally:
            await engine.dispose()


@celery_app.task(name="app.tasks.etl.collect_tokens")
def collect_tokens() -> int:
    return run_async_task(_run_with_session(lambda session: sync_pumpfun_tokens(session)))


@celery_app.task(name="app.tasks.etl.refresh_metrics")
def refresh_metrics() -> int:
    return run_async_task(
        _run_with_session(lambda session: sync_metrics_for_active_tokens(session))
    )


@celery_app.task(name="app.tasks.etl.refresh_links")
def refresh_links() -> int:
    return run_async_task(_run_with_session(lambda session: rebuild_wallet_links(session)))


@celery_app.task(name="app.tasks.etl.bootstrap_jobs")
def bootstrap_jobs() -> None:
    run_async_task(_run_with_session(lambda session: get_or_create_jobs(session)))


@celery_app.task(name="app.tasks.etl.run_full_collection")
def run_collection() -> dict[str, int]:
    return run_async_task(_run_with_session(lambda session: run_full_collection(session)))
