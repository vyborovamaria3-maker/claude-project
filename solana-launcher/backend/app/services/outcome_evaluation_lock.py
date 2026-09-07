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
    """Serialize only writers targeting the same snapshot+horizon.

    This closes the insert/check race between scheduled evaluation, manual outcome
    writes and retries without serializing unrelated tokens. PostgreSQL releases
    the lock automatically with the surrounding transaction.
    """
    bind = session.get_bind()
    if bind is None or bind.dialect.name != "postgresql":
        return
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:lock_key)"),
        {"lock_key": outcome_write_lock_key(snapshot_id, horizon_hours)},
    )
