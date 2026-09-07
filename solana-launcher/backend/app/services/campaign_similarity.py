from __future__ import annotations

import math
from datetime import datetime
from typing import Any

from sqlalchemy import Float, case, cast, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.advanced_intelligence import (
    CampaignFingerprintActor,
    CampaignFingerprintFeature,
)

CAMPAIGN_VECTOR_SCHEMA_VERSION = 2
CAMPAIGN_VECTOR_SCHEMA_KEY = "schema_v2"
CAMPAIGN_VECTOR_KEYS = (
    "x_accounts",
    "tg_channels",
    "wallets",
    "bundles",
    "shared_links",
    "copies",
    "amplifies",
    "mentions_wallet",
    "social_score",
    "x_score",
    "telegram_score",
    "organic",
    "manipulation",
    "early",
    "alpha",
    "bot_risk",
)
DEFAULT_HISTORY_LIMIT = 500
DEFAULT_NEIGHBOR_LIMIT = 10
DEFAULT_MIN_SIMILARITY = 0.5


def _finite_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def prepare_campaign_projection(
    vector: dict[str, Any],
    actors: list[Any] | tuple[Any, ...] | None,
) -> tuple[dict[str, Any] | None, list[str]]:
    """Prepare immutable numeric/actor projection values for one fingerprint."""
    actor_keys = sorted(
        {
            str(actor).strip()
            for actor in actors or []
            if str(actor).strip()
        }
    )
    schema_marker = _finite_float(vector.get(CAMPAIGN_VECTOR_SCHEMA_KEY))
    if schema_marker != 1.0:
        return None, actor_keys

    values = {
        key: _finite_float(vector.get(key)) or 0.0
        for key in CAMPAIGN_VECTOR_KEYS
    }
    vector_norm = math.sqrt(sum(value * value for value in values.values()))
    return {
        "schema_version": CAMPAIGN_VECTOR_SCHEMA_VERSION,
        **values,
        "vector_norm": vector_norm,
        "actor_count": len(actor_keys),
    }, actor_keys


async def find_campaign_neighbors(
    session: AsyncSession,
    *,
    current_mint: str,
    current_vector: dict[str, Any],
    current_actors: list[Any] | tuple[Any, ...] | None,
    limit: int = DEFAULT_NEIGHBOR_LIMIT,
    history_limit: int = DEFAULT_HISTORY_LIMIT,
    min_similarity: float = DEFAULT_MIN_SIMILARITY,
) -> list[dict[str, Any]]:
    """Return exact historical neighbors with ranking and mint dedupe in SQL.

    The scoring contract is intentionally unchanged: 75% numeric-vector cosine
    plus 25% actor-set Jaccard. Only the execution location changes. Recent
    numeric projections are scored in PostgreSQL/SQLite and only the final top-K
    rows cross the application boundary.
    """
    projection, actor_keys = prepare_campaign_projection(
        current_vector,
        current_actors,
    )
    if projection is None:
        return []

    limit = max(1, min(int(limit), 100))
    history_limit = max(limit, min(int(history_limit), 5000))
    min_similarity = max(0.0, min(float(min_similarity), 1.0))
    current_norm = float(projection["vector_norm"])

    recent_query = (
        select(CampaignFingerprintFeature)
        .where(
            CampaignFingerprintFeature.schema_version
            == CAMPAIGN_VECTOR_SCHEMA_VERSION
        )
        .order_by(
            CampaignFingerprintFeature.created_at.desc(),
            CampaignFingerprintFeature.snapshot_id.desc(),
        )
        .limit(history_limit)
    )
    if current_mint:
        recent_query = recent_query.where(
            CampaignFingerprintFeature.mint_address != current_mint
        )
    recent = recent_query.cte("recent_campaign_fingerprints")

    if actor_keys:
        actor_hits = (
            select(
                CampaignFingerprintActor.snapshot_id.label("snapshot_id"),
                func.count().label("actor_intersection"),
            )
            .join(
                recent,
                recent.c.snapshot_id == CampaignFingerprintActor.snapshot_id,
            )
            .where(CampaignFingerprintActor.actor_key.in_(actor_keys))
            .group_by(CampaignFingerprintActor.snapshot_id)
            .cte("campaign_actor_hits")
        )
        from_clause = recent.outerjoin(
            actor_hits,
            actor_hits.c.snapshot_id == recent.c.snapshot_id,
        )
        actor_intersection = func.coalesce(
            actor_hits.c.actor_intersection,
            literal(0),
        )
    else:
        from_clause = recent
        actor_intersection = literal(0)

    dot = literal(0.0)
    for key in CAMPAIGN_VECTOR_KEYS:
        dot = dot + getattr(recent.c, key) * float(projection[key])

    vector_denominator = recent.c.vector_norm * current_norm
    vector_similarity = case(
        (vector_denominator > 0.0, dot / vector_denominator),
        else_=literal(0.0),
    )
    actor_union = (
        recent.c.actor_count
        + len(actor_keys)
        - actor_intersection
    )
    actor_similarity = case(
        (
            actor_union > 0,
            cast(actor_intersection, Float) / cast(actor_union, Float),
        ),
        else_=literal(0.0),
    )
    similarity = vector_similarity * 0.75 + actor_similarity * 0.25

    scored = (
        select(
            recent.c.snapshot_id,
            recent.c.mint_address,
            recent.c.created_at,
            vector_similarity.label("vector_similarity"),
            actor_similarity.label("actor_similarity"),
            similarity.label("similarity"),
        )
        .select_from(from_clause)
        .where(similarity >= min_similarity)
        .cte("scored_campaign_neighbors")
    )
    ranked = (
        select(
            scored,
            func.row_number()
            .over(
                partition_by=scored.c.mint_address,
                order_by=(
                    scored.c.similarity.desc(),
                    scored.c.created_at.desc(),
                    scored.c.snapshot_id.desc(),
                ),
            )
            .label("mint_rank"),
        )
        .cte("ranked_campaign_neighbors")
    )
    rows = (
        await session.execute(
            select(
                ranked.c.snapshot_id,
                ranked.c.mint_address,
                ranked.c.created_at,
                ranked.c.similarity,
                ranked.c.vector_similarity,
                ranked.c.actor_similarity,
            )
            .where(ranked.c.mint_rank == 1)
            .order_by(
                ranked.c.similarity.desc(),
                ranked.c.created_at.desc(),
                ranked.c.snapshot_id.desc(),
            )
            .limit(limit)
        )
    ).all()

    neighbors: list[dict[str, Any]] = []
    for row in rows:
        created_at = row.created_at
        if isinstance(created_at, datetime):
            created_at_value = created_at.isoformat()
        else:
            created_at_value = str(created_at)
        neighbors.append(
            {
                "snapshot_id": str(row.snapshot_id),
                "mint": str(row.mint_address),
                "similarity": round(float(row.similarity), 4),
                "vector_similarity": round(float(row.vector_similarity), 4),
                "actor_similarity": round(float(row.actor_similarity), 4),
                "created_at": created_at_value,
            }
        )
    return neighbors
