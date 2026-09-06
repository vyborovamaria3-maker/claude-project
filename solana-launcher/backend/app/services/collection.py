from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.services.etl import sync_metrics_for_active_tokens, sync_pumpfun_tokens
from app.services.observability import ETL_ERRORS, ETL_RUNTIME
from app.services.wallet_clusters import rebuild_wallet_links


async def run_full_collection(
    session: AsyncSession,
    settings: Settings | None = None,
) -> dict[str, int]:
    """Run the collector with the optimized derived-data rebuild path."""
    settings = settings or get_settings()
    with ETL_RUNTIME.time():
        try:
            tokens = await sync_pumpfun_tokens(session, settings)
            metrics = await sync_metrics_for_active_tokens(session, settings)
            links = await rebuild_wallet_links(session)
            await session.commit()
            return {"tokens": tokens, "metrics": metrics, "links": links}
        except Exception:
            ETL_ERRORS.inc()
            await session.rollback()
            raise
