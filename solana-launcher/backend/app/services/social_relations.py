from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.social_intelligence import SocialRelation


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


async def upsert_social_relation(
    session: AsyncSession,
    *,
    source_platform: str,
    source_handle: str,
    target_platform: str,
    target_handle: str,
    relation_type: str,
    evidence: str = "",
    occurred_at: datetime | None = None,
) -> SocialRelation:
    when = occurred_at or datetime.now(timezone.utc)
    relation = (
        await session.execute(
            select(SocialRelation).where(
                SocialRelation.source_platform == source_platform,
                SocialRelation.source_handle == source_handle,
                SocialRelation.target_platform == target_platform,
                SocialRelation.target_handle == target_handle,
                SocialRelation.relation_type == relation_type,
            )
        )
    ).scalar_one_or_none()
    if relation is None:
        relation = SocialRelation(
            source_platform=source_platform,
            source_handle=source_handle,
            target_platform=target_platform,
            target_handle=target_handle,
            relation_type=relation_type,
            count=1,
            first_seen_at=when,
            last_seen_at=when,
            evidence=(evidence or "")[:1000],
        )
        session.add(relation)
    else:
        # Discussion linkage is structural and should remain count=1 across rescans.
        if relation_type != "discussion":
            relation.count += 1
        relation.first_seen_at = min(_aware(relation.first_seen_at), _aware(when))
        relation.last_seen_at = max(_aware(relation.last_seen_at), _aware(when))
        if evidence:
            relation.evidence = evidence[:1000]
    await session.flush()
    return relation
