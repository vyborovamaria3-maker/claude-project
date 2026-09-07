from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.advanced_intelligence import (
    IntelligenceEntityOutcomeProjection,
    IntelligenceOutcome,
)
from app.models.intelligence_memory import (
    IntelligenceSnapshot,
    IntelligenceSnapshotEntity,
)

PERFORMANCE_ENTITY_TYPES = ("x_account", "tg_channel", "wallet")


async def refresh_entity_outcome_projection_for_mint(
    session: AsyncSession,
    *,
    mint_address: str,
    horizon_hours: int,
) -> int:
    """Refresh prepared earliest-snapshot outcomes for one token/horizon.

    The projection deliberately gives each entity one vote per token. It uses the
    earliest retained snapshot containing that entity, matching the historical
    source-reliability selection rule while moving the expensive join off the
    user-facing report path.
    """
    ranked = (
        select(
            IntelligenceSnapshotEntity.entity_key.label("entity_key"),
            IntelligenceSnapshotEntity.entity_type.label("entity_type"),
            IntelligenceSnapshot.snapshot_id.label("snapshot_id"),
            func.row_number()
            .over(
                partition_by=IntelligenceSnapshotEntity.entity_key,
                order_by=(
                    IntelligenceSnapshot.created_at.asc(),
                    IntelligenceSnapshot.snapshot_id.asc(),
                ),
            )
            .label("rn"),
        )
        .join(
            IntelligenceSnapshot,
            IntelligenceSnapshot.snapshot_id
            == IntelligenceSnapshotEntity.snapshot_id,
        )
        .where(
            IntelligenceSnapshot.mint_address == mint_address,
            IntelligenceSnapshotEntity.entity_type.in_(PERFORMANCE_ENTITY_TYPES),
        )
        .subquery()
    )
    earliest = list(
        (
            await session.execute(
                select(
                    ranked.c.entity_key,
                    ranked.c.entity_type,
                    ranked.c.snapshot_id,
                ).where(ranked.c.rn == 1)
            )
        ).all()
    )
    if not earliest:
        return 0

    snapshot_ids = {str(row.snapshot_id) for row in earliest}
    outcomes = list(
        (
            await session.execute(
                select(IntelligenceOutcome).where(
                    IntelligenceOutcome.snapshot_id.in_(snapshot_ids),
                    IntelligenceOutcome.horizon_hours == horizon_hours,
                    IntelligenceOutcome.max_multiple.is_not(None),
                )
            )
        ).scalars().all()
    )
    outcome_by_snapshot = {row.snapshot_id: row for row in outcomes}
    prepared = [
        (row, outcome_by_snapshot.get(str(row.snapshot_id)))
        for row in earliest
    ]
    prepared = [(row, outcome) for row, outcome in prepared if outcome is not None]
    if not prepared:
        return 0

    entity_keys = [str(row.entity_key) for row, _ in prepared]
    existing_rows = list(
        (
            await session.execute(
                select(IntelligenceEntityOutcomeProjection).where(
                    IntelligenceEntityOutcomeProjection.entity_key.in_(entity_keys),
                    IntelligenceEntityOutcomeProjection.mint_address == mint_address,
                    IntelligenceEntityOutcomeProjection.horizon_hours == horizon_hours,
                )
            )
        ).scalars().all()
    )
    existing = {row.entity_key: row for row in existing_rows}
    updated_at = datetime.now(timezone.utc)

    for earliest_row, outcome in prepared:
        assert outcome is not None
        entity_key = str(earliest_row.entity_key)
        values = {
            "entity_type": str(earliest_row.entity_type),
            "snapshot_id": str(earliest_row.snapshot_id),
            "max_multiple": outcome.max_multiple,
            "max_drawdown_pct": outcome.max_drawdown_pct,
            "outcome_label": outcome.outcome_label,
            "evaluated_at": outcome.evaluated_at,
            "updated_at": updated_at,
        }
        projection = existing.get(entity_key)
        if projection is None:
            projection = IntelligenceEntityOutcomeProjection(
                entity_key=entity_key,
                mint_address=mint_address,
                horizon_hours=horizon_hours,
                **values,
            )
            session.add(projection)
            existing[entity_key] = projection
        else:
            for key, value in values.items():
                setattr(projection, key, value)

    return len(prepared)
