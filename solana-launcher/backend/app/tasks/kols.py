from __future__ import annotations

import asyncio

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.kol_metrics import refresh_kol_metrics
from app.tasks.celery_app import celery_app


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
    return asyncio.run(_run_refresh())
