from __future__ import annotations

import hashlib

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

_LOCK_NAMESPACE = b"potapoff:intelligence:matured-outcomes:v1"
OUTCOME_EVALUATION_LOCK_KEY = int.from_bytes(
    hashlib.sha256(_LOCK_NAMESPACE).digest()[:8],
    byteorder="big",
    signed=True,
)


def _signed_lock_key(value: bytes) -> int:
    return int.from_bytes(
        hashlib.sha256(value).digest()[:8],
        byteorder="big",
        signed=True,
    )


def outcome_write_lock_key(snapshot_id: str, horizon_hours: int) -> int:
    return _signed_lock_key(
        f"potapoff:intelligence:outcome:{snapshot_id}:{horizon_hours}".encode("utf-8")
    )


def calibration_lock_key(model_version: str, signal_type: str, bucket: str) -> int:
    return _signed_lock_key(
        (
            "potapoff:intelligence:calibration:"
            f"{model_version}:{signal_type}:{bucket}"
        ).encode("utf-8")
    )


def entity_projection_lock_key(mint_address: str, horizon_hours: int) -> int:
    return _signed_lock_key(
        (
            "potapoff:intelligence:entity-projection:"
            f"{mint_address}:{horizon_hours}"
        ).encode("utf-8")
    )


async def _acquire_xact_lock(session: AsyncSession, lock_key: int) -> None:
    bind = session.get_bind()
    if bind is None or bind.dialect.name != "postgresql":
        return
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:lock_key)"),
        {"lock_key": lock_key},
    )


async def try_acquire_outcome_evaluation_lock(session: AsyncSession) -> bool:
    """Acquire one transaction-scoped scheduled-evaluator lease in PostgreSQL."""
    bind = session.get_bind()
    if bind is None or bind.dialect.name != "postgresql":
        return True
    acquired = await session.scalar(
        text("SELECT pg_try_advisory_xact_lock(:lock_key)"),
        {"lock_key": OUTCOME_EVALUATION_LOCK_KEY},
    )
    return bool(acquired)


async def acquire_outcome_write_lock(
    session: AsyncSession,
    *,
    snapshot_id: str,
    horizon_hours: int,
) -> None:
    """Enter the outcome-learning write order, then lock one outcome row key.

    The scheduled evaluator intentionally keeps one transaction across a batch and
    therefore accumulates per-outcome/calibration/projection locks. Manual writes
    must not enter that graph from the middle or they can form a lock cycle. Every
    outcome writer first acquires the same outer lease used by the scheduled job;
    scheduled calls are re-entrant on that transaction lock. The narrower lock is
    retained as a second line of defense and documents the row-level resource.
    """
    await _acquire_xact_lock(session, OUTCOME_EVALUATION_LOCK_KEY)
    await _acquire_xact_lock(
        session,
        outcome_write_lock_key(snapshot_id, horizon_hours),
    )


async def acquire_calibration_write_lock(
    session: AsyncSession,
    *,
    model_version: str,
    signal_type: str,
    bucket: str,
) -> None:
    """Protect one calibration bucket's read-modify-write counters."""
    await _acquire_xact_lock(
        session,
        calibration_lock_key(model_version, signal_type, bucket),
    )


async def acquire_entity_projection_write_lock(
    session: AsyncSession,
    *,
    mint_address: str,
    horizon_hours: int,
) -> None:
    """Serialize reconciliation of one mint+horizon entity projection."""
    await _acquire_xact_lock(
        session,
        entity_projection_lock_key(mint_address, horizon_hours),
    )
