from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import case, func, literal, literal_column, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.social_intelligence import SocialEvent
from app.services.observability import ANALYSIS_STAGE_RUNTIME


def _filters(
    *,
    mint_address: str | None,
    platform: str | None,
    hours: int | None,
):
    filters = []
    if mint_address:
        filters.append(SocialEvent.mint_address == mint_address)
    if platform:
        filters.append(func.lower(SocialEvent.platform) == platform.lower())
    if hours is not None:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=max(1, int(hours)))
        filters.append(SocialEvent.occurred_at >= cutoff)
    return filters


def postgres_social_search_statement(
    *,
    query: str,
    mint_address: str | None = None,
    platform: str | None = None,
    hours: int | None = None,
    limit: int = 50,
):
    """Build the production FTS/trigram query without loading social history."""
    normalized_query = query.strip().lower()
    config = literal_column("'simple'")
    document = func.to_tsvector(config, func.coalesce(SocialEvent.text, ""))
    ts_query = func.websearch_to_tsquery(config, query.strip())
    rank = func.ts_rank_cd(document, ts_query)
    lowered_text = func.lower(func.coalesce(SocialEvent.text, ""))
    trigram = func.similarity(lowered_text, normalized_query)
    substring_match = lowered_text.contains(normalized_query)
    score = (
        rank
        + trigram * 0.20
        + case((substring_match, literal(0.10)), else_=literal(0.0))
    ).label("search_score")

    statement = (
        select(SocialEvent, score)
        .where(
            * _filters(
                mint_address=mint_address,
                platform=platform,
                hours=hours,
            ),
            (
                document.op("@@")(ts_query)
                | substring_match
                | (trigram >= 0.25)
            ),
        )
        .order_by(score.desc(), SocialEvent.occurred_at.desc(), SocialEvent.id.desc())
        .limit(max(1, min(int(limit), 100)))
    )
    return statement


async def search_social_events(
    session: AsyncSession,
    *,
    query: str,
    mint_address: str | None = None,
    platform: str | None = None,
    hours: int | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Search token-linked X/TG evidence using PostgreSQL FTS + pg_trgm.

    SQLite uses a bounded substring fallback for local development/tests. The
    production path ranks matches inside PostgreSQL and transfers only final rows.
    """
    cleaned = query.strip()
    if len(cleaned) < 2:
        return []
    max_items = max(1, min(int(limit), 100))
    dialect = session.bind.dialect.name if session.bind is not None else ""

    if dialect == "postgresql":
        statement = postgres_social_search_statement(
            query=cleaned,
            mint_address=mint_address,
            platform=platform,
            hours=hours,
            limit=max_items,
        )
        with ANALYSIS_STAGE_RUNTIME.labels(stage="social_text_search").time():
            rows = (await session.execute(statement)).all()
        materialized = [(event, float(score or 0.0)) for event, score in rows]
        mode = "postgres_fts_trgm"
    else:
        lowered = cleaned.lower()
        statement = (
            select(SocialEvent)
            .where(
                *_filters(
                    mint_address=mint_address,
                    platform=platform,
                    hours=hours,
                ),
                func.lower(func.coalesce(SocialEvent.text, "")).contains(lowered),
            )
            .order_by(SocialEvent.occurred_at.desc(), SocialEvent.id.desc())
            .limit(max_items)
        )
        with ANALYSIS_STAGE_RUNTIME.labels(stage="social_text_search").time():
            events = list((await session.execute(statement)).scalars().all())
        materialized = [(event, 1.0) for event in events]
        mode = "bounded_substring_fallback"

    return [
        {
            "id": event.id,
            "platform": event.platform,
            "event_type": event.event_type,
            "external_id": event.external_id,
            "source_handle": event.source_handle,
            "source_name": event.source_name,
            "source_url": event.source_url,
            "mint_address": event.mint_address,
            "symbol": event.symbol,
            "text": event.text,
            "occurred_at": event.occurred_at,
            "metrics": event.metrics,
            "score": round(score, 6),
            "search_mode": mode,
        }
        for event, score in materialized
    ]
