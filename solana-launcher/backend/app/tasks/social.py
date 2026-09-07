from __future__ import annotations

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.social_hot_paths import ingest_x_events_bulk
from app.services.social_intelligence import refresh_x_for_mint
from app.tasks.async_runtime import run_async_task
from app.tasks.celery_app import celery_app


async def _refresh(mint: str, symbol: str | None = None) -> dict[str, int]:
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    try:
        payload = await refresh_x_for_mint(
            backend_frontend_url=settings.frontend_internal_url,
            mint_address=mint,
            symbol=symbol,
        )
        async with sessionmaker() as session:
            return await ingest_x_events_bulk(session, payload)
    finally:
        await engine.dispose()


@celery_app.task(
    name="app.tasks.social.refresh_x",
    acks_late=True,
)
def refresh_x(mint: str, symbol: str | None = None) -> dict[str, int]:
    return run_async_task(_refresh(mint, symbol))
