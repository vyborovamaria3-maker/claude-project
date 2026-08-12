from __future__ import annotations

import asyncio

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.intelligence_outcomes import evaluate_matured_outcomes
from app.tasks.celery_app import celery_app


async def _evaluate() -> dict[str, int]:
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    async with sessionmaker() as session:
        try:
            result = await evaluate_matured_outcomes(session)
            await session.commit()
            return result
        except Exception:
            await session.rollback()
            raise
        finally:
            await engine.dispose()


@celery_app.task(name="app.tasks.intelligence.evaluate_matured_outcomes")
def evaluate_intelligence_outcomes() -> dict[str, int]:
    return asyncio.run(_evaluate())
