from __future__ import annotations

import hashlib
from collections.abc import Iterable

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


def persistence_lock_key(resource: str) -> int:
    return int.from_bytes(
        hashlib.sha256(
            f"potapoff:intelligence:persistence:v1:{resource}".encode("utf-8")
        ).digest()[:8],
        byteorder="big",
        signed=True,
    )


async def acquire_intelligence_persistence_locks(
    session: AsyncSession,
    resources: Iterable[str],
) -> None:
    """Serialize writes that share durable intelligence keys.

    All hashed keys are sorted before acquisition. That deterministic ordering is
    important when two reports overlap on more than one narrative/hypothesis key:
    it prevents the classic A-then-B / B-then-A advisory-lock deadlock.
    """
    bind = session.get_bind()
    if bind is None or bind.dialect.name != "postgresql":
        return

    lock_keys = sorted({persistence_lock_key(resource) for resource in resources if resource})
    for lock_key in lock_keys:
        await session.execute(
            text("SELECT pg_advisory_xact_lock(:lock_key)"),
            {"lock_key": lock_key},
        )
