from __future__ import annotations

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.intelligence_outcomes import evaluate_matured_outcomes
from app.services.outcome_evaluation_lock import try_acquire_outcome_evaluation_lock
from app.tasks.async_runtime import run_async_task
from app.tasks.celery_app import celery_app

_EMPTY_RESULT = {
    "snapshots": 0,
    "candidates_scanned": 0,
    "evaluated": 0,
    "censored": 0,
    "skipped": 0,
}


async def _evaluate() -> dict[str, int]:
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    async with sessionmaker() as session:
        try:
            if not await try_acquire_outcome_evaluation_lock(session):
                # Another intelligence worker owns the transaction-scoped lease.
                # Do no duplicate work; the next Beat run can continue normally.
                return dict(_EMPTY_RESULT)
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
    return run_async_task(_evaluate())
