from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from sqlalchemy import Float, and_, case, cast, delete, func, insert, literal, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analytics import WalletLink, WalletTrade
from app.services.observability import WALLET_LINKS_CREATED

_WALLET_LINK_REBUILD_LOCK_KEY = int.from_bytes(
    hashlib.sha256(b"potapoff:wallet-links:rebuild:v1").digest()[:8],
    byteorder="big",
    signed=True,
)


async def _acquire_rebuild_lock(session: AsyncSession) -> None:
    """Serialize replace-all rebuilds without blocking unrelated DB work."""
    bind = session.get_bind()
    if bind is None or bind.dialect.name != "postgresql":
        return
    await session.execute(
        text("SELECT pg_advisory_xact_lock(:lock_key)"),
        {"lock_key": _WALLET_LINK_REBUILD_LOCK_KEY},
    )


async def rebuild_wallet_links(
    session: AsyncSession,
    *,
    min_shared_tokens: int = 3,
) -> int:
    """Recompute meaningful wallet links with set-based SQL.

    The old implementation generated wallet pairs in Python and performed a SELECT
    for every pair. It was both N+1-heavy and non-idempotent: every daily run could
    increment an already-counted shared token again. This query first deduplicates
    wallet/token participation, self-joins it once in the database, and replaces the
    derived wallet_links table transactionally.
    """
    minimum = max(1, int(min_shared_tokens))
    # DELETE + INSERT replaces one global derived projection. Manual collection and
    # scheduled workers can overlap, so serialize only this rebuild for the lifetime
    # of the caller's transaction. PostgreSQL releases the lock on commit/rollback.
    await _acquire_rebuild_lock(session)

    participation = (
        select(
            WalletTrade.wallet_id.label("wallet_id"),
            WalletTrade.token_id.label("token_id"),
            func.min(WalletTrade.buy_timestamp).label("first_seen"),
        )
        .group_by(WalletTrade.wallet_id, WalletTrade.token_id)
        .subquery("wallet_token_participation")
    )
    left = participation.alias("wallet_a")
    right = participation.alias("wallet_b")

    pair_first_seen = case(
        (left.c.first_seen >= right.c.first_seen, left.c.first_seen),
        else_=right.c.first_seen,
    )
    shared_count = func.count().label("shared_tokens_count")
    now = datetime.now(timezone.utc)

    pair_rows = (
        select(
            left.c.wallet_id.label("wallet_a_id"),
            right.c.wallet_id.label("wallet_b_id"),
            shared_count,
            func.min(pair_first_seen).label("first_interaction_date"),
            cast(func.count(), Float).label("similarity_score"),
            literal(None).label("details"),
            literal(now).label("created_at"),
        )
        .select_from(
            left.join(
                right,
                and_(
                    left.c.token_id == right.c.token_id,
                    left.c.wallet_id < right.c.wallet_id,
                ),
            )
        )
        .group_by(left.c.wallet_id, right.c.wallet_id)
        .having(func.count() >= minimum)
    )

    await session.execute(delete(WalletLink))
    await session.execute(
        insert(WalletLink).from_select(
            [
                "wallet_a_id",
                "wallet_b_id",
                "shared_tokens_count",
                "first_interaction_date",
                "similarity_score",
                "details",
                "created_at",
            ],
            pair_rows,
        )
    )

    count = int(await session.scalar(select(func.count()).select_from(WalletLink)) or 0)
    WALLET_LINKS_CREATED.inc(count)
    return count
