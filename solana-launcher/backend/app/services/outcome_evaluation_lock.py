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


async def try_acquire_outcome_evaluation_lock(session: AsyncSession) -> bool:
    """Acquire one transaction-scoped evaluator lease in PostgreSQL.

    The lock is released automatically by PostgreSQL on commit/rollback or
    connection loss. SQLite/local tests do not need cross-process coordination.
    """
    bind = session.get_bind()
    if bind is None or bind.dialect.name != "postgresql":
        return True
    acquired = await session.scalar(
        text("SELECT pg_try_advisory_xact_lock(:lock_key)"),
        {"lock_key": OUTCOME_EVALUATION_LOCK_KEY},
    )
    return bool(acquired)
