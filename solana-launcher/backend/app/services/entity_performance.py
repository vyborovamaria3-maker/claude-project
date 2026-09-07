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
from app.services.outcome_evaluation_lock import acquire_entity_projection_write_lock

PERFORMANCE_ENTITY_TYPES = ("x_account", "tg_channel", "wallet")


async def refresh_entity_outcome_projection_for_mint(
    session: AsyncSession,
    *,
    mint_address: str,
    horizon_hours: int,
) -> int:
    """Reconcile prepared earliest-snapshot outcomes for one token/horizon.

    Each entity receives at most one vote per token. If the causal earliest
    snapshot has no usable outcome anymore, a stale projection is removed in the
    same transaction instead of silently influencing future reputation scores.
    """
    # Different snapshot+horizon writers for the same mint can converge on the
    # same entity projection row. Serialize only this mint+horizon reconciliation;
    # unrelated tokens continue in parallel.
    await acquire_entity_projection_write_lock(
        session,
        mint_address=mint_address,
        horizon_hours=horizon_hours,
    )

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

    existing_rows = list(
        (
            await session.execute(
                select(IntelligenceEntityOutcomeProjection).where(
                    IntelligenceEntityOutcomeProjection.mint_address == mint_address,
                    IntelligenceEntityOutcomeProjection.horizon_hours == horizon_hours,
                )
            )
        ).scalars().all()
    )
    existing = {row.entity_key: row for row in existing_rows}

    if not earliest:
        for projection in existing_rows:
            await session.delete(projection)
        return 0

    snapshot_ids = {str(row.snapshot_id) for row in earliest}
    outcomes = list(
        (
            await session.execute(
                select(IntelligenceOutcome).where(
                    IntelligenceOutcome.snapshot_id.in_(snapshot_ids),
                    IntelligenceOutcome.horizon_hours == horizon_hours,
                )
            )
        ).scalars().all()
    )
    outcome_by_snapshot = {row.snapshot_id: row for row in outcomes}
    desired_keys: set[str] = set()
    deleted_keys: set[str] = set()
    updated_at = datetime.now(timezone.utc)

    for earliest_row in earliest:
        entity_key = str(earliest_row.entity_key)
        outcome = outcome_by_snapshot.get(str(earliest_row.snapshot_id))
        if outcome is None or outcome.max_multiple is None:
            projection = existing.get(entity_key)
            if projection is not None:
                await session.delete(projection)
                deleted_keys.add(entity_key)
            continue

        desired_keys.add(entity_key)
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

    earliest_keys = {str(row.entity_key) for row in earliest}
    for entity_key, projection in existing.items():
        if entity_key in deleted_keys:
            continue
        if entity_key not in earliest_keys or entity_key not in desired_keys:
            await session.delete(projection)

    return len(desired_keys)
