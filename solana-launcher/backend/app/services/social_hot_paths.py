from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import bindparam, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.social_intelligence import (
    SocialEvent,
    TelegramChannel,
    TelegramChannelScore,
)
from app.services.observability import ANALYSIS_STAGE_RUNTIME
from app.services.social_filters import filter_timeline_payload, normalize_social_source


def _tweet_timestamp(value: Any) -> datetime | None:
    if isinstance(value, (int, float)):
        seconds = value / 1000 if value > 10_000_000_000 else value
        return datetime.fromtimestamp(seconds, tz=timezone.utc)
    return None


def _tweet_metrics(tweet: dict[str, Any]) -> dict[str, Any]:
    suspicion_score = float(tweet.get("suspicion_score") or 0)
    return {
        "views": int(tweet.get("views") or 0),
        "likes": int(tweet.get("likes") or 0),
        "retweets": int(tweet.get("retweets") or 0),
        "replies": int(tweet.get("replies") or 0),
        "verified": bool(tweet.get("is_verified")),
        "suspicion_score": tweet.get("suspicion_score"),
        "suspicious": suspicion_score >= 50.0,
    }


async def ingest_x_events_bulk(
    session: AsyncSession,
    payload: dict[str, Any],
) -> dict[str, int]:
    """Persist one X refresh with a single existing-row lookup instead of N queries."""
    mint = str(payload.get("token_mint") or "").strip() or None
    symbol = str(payload.get("token_symbol") or "").strip() or None
    strategy = payload.get("strategy")

    prepared: dict[str, tuple[dict[str, Any], datetime]] = {}
    skipped_missing_timestamp = 0
    for tweet in payload.get("tweets") or []:
        if not isinstance(tweet, dict):
            continue
        external_id = str(tweet.get("id") or "").strip()
        if not external_id:
            continue
        occurred_at = _tweet_timestamp(tweet.get("posted_at"))
        if occurred_at is None:
            skipped_missing_timestamp += 1
            continue
        prepared[external_id] = (tweet, occurred_at)

    if not prepared:
        return {
            "inserted": 0,
            "updated": 0,
            "skipped_missing_timestamp": skipped_missing_timestamp,
        }

    external_ids = list(prepared)
    existing_rows = list(
        (
            await session.execute(
                select(SocialEvent).where(
                    SocialEvent.platform == "x",
                    SocialEvent.event_type == "token_mention",
                    SocialEvent.mint_address == mint,
                    SocialEvent.external_id.in_(external_ids),
                )
            )
        ).scalars().all()
    )
    existing_by_id = {row.external_id: row for row in existing_rows}

    inserted = 0
    updated = 0
    for external_id, (tweet, occurred_at) in prepared.items():
        metrics = _tweet_metrics(tweet)
        existing = existing_by_id.get(external_id)
        if existing is None:
            session.add(
                SocialEvent(
                    platform="x",
                    event_type="token_mention",
                    external_id=external_id,
                    source_handle=tweet.get("author_handle"),
                    source_name=tweet.get("author_display_name"),
                    source_url=tweet.get("url"),
                    mint_address=mint,
                    symbol=symbol,
                    text=str(tweet.get("text") or ""),
                    occurred_at=occurred_at,
                    metrics=metrics,
                    payload={"strategy": strategy},
                )
            )
            inserted += 1
            continue

        existing.source_handle = tweet.get("author_handle") or existing.source_handle
        existing.source_name = tweet.get("author_display_name") or existing.source_name
        existing.source_url = tweet.get("url") or existing.source_url
        existing.text = str(tweet.get("text") or existing.text)
        existing.occurred_at = occurred_at
        existing.metrics = metrics
        existing.payload = {"strategy": strategy}
        updated += 1

    await session.commit()
    return {
        "inserted": inserted,
        "updated": updated,
        "skipped_missing_timestamp": skipped_missing_timestamp,
    }


async def channel_score_lookup(
    session: AsyncSession,
    *,
    min_score: float = 0.0,
) -> dict[str, float]:
    """Load the score lookup in one narrow query rather than paging full channel rows."""
    statement = (
        select(
            TelegramChannel.username,
            TelegramChannel.telegram_id,
            TelegramChannelScore.score,
        )
        .join(
            TelegramChannelScore,
            TelegramChannelScore.channel_id == TelegramChannel.id,
        )
        .where(TelegramChannelScore.score >= max(0.0, float(min_score)))
    )
    rows = (await session.execute(statement)).all()
    result: dict[str, float] = {}
    for username, telegram_id, score in rows:
        value = float(score or 0.0)
        if username:
            result[normalize_social_source(str(username))] = value
        if telegram_id is not None:
            result[normalize_social_source(str(telegram_id))] = value
    return result


async def token_timeline_candidates(
    session: AsyncSession,
    mint_address: str,
    *,
    platform: str | None = None,
    hours: int | None = None,
) -> dict[str, Any]:
    """Push stable timeline filters into SQL before Python-only social filtering."""
    statement = select(SocialEvent).where(SocialEvent.mint_address == mint_address)
    if platform:
        statement = statement.where(SocialEvent.platform == platform.lower())
    if hours is not None:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=max(1, int(hours)))
        statement = statement.where(SocialEvent.occurred_at >= cutoff)

    events = list(
        (
            await session.execute(statement.order_by(SocialEvent.occurred_at.asc()))
        ).scalars().all()
    )
    platforms: defaultdict[str, int] = defaultdict(int)
    timeline: list[dict[str, Any]] = []
    for index, event in enumerate(events):
        platforms[event.platform] += 1
        timeline.append(
            {
                "rank": index + 1,
                "platform": event.platform,
                "event_type": event.event_type,
                "source_handle": event.source_handle,
                "source_name": event.source_name,
                "source_url": event.source_url,
                "text": event.text,
                "occurred_at": event.occurred_at,
                "metrics": event.metrics,
            }
        )
    return {
        "mint_address": mint_address,
        "mentions": len(events),
        "platforms": dict(platforms),
        "origin": timeline[0] if timeline else None,
        "timeline": timeline,
    }


def _postgres_timeline_cte() -> str:
    source_key = """
        split_part(
            split_part(
                split_part(
                    btrim(
                        regexp_replace(
                            regexp_replace(
                                lower(ltrim(btrim(coalesce(source_handle, source_name, '')), '@')),
                                '^https?://t[.]me/',
                                ''
                            ),
                            '^t[.]me/',
                            ''
                        ),
                        '/'
                    ),
                    '/', 1
                ),
                '?', 1
            ),
            '#', 1
        )
    """

    def metric(key: str) -> str:
        return f"""
            CASE
                WHEN coalesce(CAST(metrics AS jsonb) ->> '{key}', '') ~ '^-?[0-9]+$'
                THEN greatest(CAST(CAST(metrics AS jsonb) ->> '{key}' AS bigint), 0)
                ELSE 0
            END
        """

    engagement = f"""
        CASE
            WHEN lower(platform) = 'telegram' THEN
                {metric('reactions')} + {metric('forwards')} + {metric('replies')}
            ELSE
                {metric('likes')} + {metric('retweets')} + {metric('replies')}
        END
    """
    explicit_call = """
        CASE
            WHEN lower(platform) <> 'telegram' THEN false
            WHEN CAST(metrics AS jsonb) -> 'explicit_call' = CAST('true' AS jsonb) THEN true
            WHEN CAST(metrics AS jsonb) -> 'is_explicit_call' = CAST('true' AS jsonb) THEN true
            WHEN lower(event_type) LIKE '%call%' THEN true
            ELSE false
        END
    """
    channel_username = """
        split_part(
            split_part(
                split_part(
                    btrim(
                        regexp_replace(
                            regexp_replace(
                                lower(ltrim(btrim(coalesce(ch.username, '')), '@')),
                                '^https?://t[.]me/',
                                ''
                            ),
                            '^t[.]me/',
                            ''
                        ),
                        '/'
                    ),
                    '/', 1
                ),
                '?', 1
            ),
            '#', 1
        )
    """
    return f"""
        WITH prepared AS (
            SELECT
                id,
                lower(platform) AS platform,
                event_type,
                source_handle,
                source_name,
                source_url,
                text,
                occurred_at,
                metrics,
                payload,
                {source_key} AS source_key,
                {engagement} AS engagement,
                {explicit_call} AS explicit_call
            FROM social_events
            WHERE mint_address = :mint
              AND (:platform IS NULL OR lower(platform) = :platform)
              AND (:cutoff IS NULL OR occurred_at >= :cutoff)
        ),
        filtered AS (
            SELECT prepared.*
            FROM prepared
            WHERE (:has_sources = false OR source_key IN :sources)
              AND (
                    :explicit_calls_only = false
                    OR platform <> 'telegram'
                    OR explicit_call
              )
              AND engagement >= :min_engagement
              AND (
                    :min_channel_score <= 0
                    OR platform <> 'telegram'
                    OR EXISTS (
                        SELECT 1
                        FROM telegram_channels AS ch
                        JOIN telegram_channel_scores AS score
                          ON score.channel_id = ch.id
                        WHERE score.score >= :min_channel_score
                          AND (
                                {channel_username} = prepared.source_key
                                OR CAST(ch.telegram_id AS text) = prepared.source_key
                          )
                    )
              )
        )
    """


async def filtered_token_timeline(
    session: AsyncSession,
    mint_address: str,
    *,
    platform: str | None = None,
    hours: int | None = None,
    sources: set[str] | None = None,
    explicit_calls_only: bool = False,
    min_engagement: int = 0,
    min_channel_score: float = 0.0,
    limit: int = 200,
) -> dict[str, Any]:
    """Return a filtered social timeline without materializing the full token history.

    Production PostgreSQL applies every stable filter before transferring rows and
    uses constant-count aggregate queries for response metadata. SQLite keeps the
    legacy Python filter as a development/test compatibility path.
    """
    normalized_sources = sorted(
        {
            normalize_social_source(value)
            for value in (sources or set())
            if value.strip()
        }
    )
    max_items = max(1, min(int(limit), 1000))
    cutoff = (
        datetime.now(timezone.utc) - timedelta(hours=max(1, int(hours)))
        if hours is not None
        else None
    )
    dialect = session.bind.dialect.name if session.bind is not None else ""
    if dialect != "postgresql":
        timeline = await token_timeline_candidates(
            session,
            mint_address,
            platform=platform,
            hours=hours,
        )
        scores = (
            await channel_score_lookup(session, min_score=min_channel_score)
            if min_channel_score > 0
            else {}
        )
        return filter_timeline_payload(
            timeline,
            platform=platform,
            hours=hours,
            sources=set(normalized_sources),
            explicit_calls_only=explicit_calls_only,
            min_engagement=min_engagement,
            min_channel_score=min_channel_score,
            channel_scores=scores,
            limit=max_items,
        )

    params: dict[str, Any] = {
        "mint": mint_address,
        "platform": platform.lower() if platform else None,
        "cutoff": cutoff,
        "has_sources": bool(normalized_sources),
        "sources": normalized_sources or [""],
        "explicit_calls_only": bool(explicit_calls_only),
        "min_engagement": max(0, int(min_engagement)),
        "min_channel_score": max(0.0, float(min_channel_score)),
        "limit": max_items,
    }
    cte = _postgres_timeline_cte()
    aggregate_sql = text(
        cte
        + """
        , platform_counts AS (
            SELECT platform, CAST(count(*) AS bigint) AS count
            FROM filtered
            GROUP BY platform
        )
        SELECT
            CAST(count(*) AS bigint) AS matched_before_limit,
            CAST(count(DISTINCT nullif(source_key, '')) AS bigint) AS unique_sources,
            CAST(
                coalesce(
                    sum(CASE WHEN platform = 'telegram' AND explicit_call THEN 1 ELSE 0 END),
                    0
                ) AS bigint
            ) AS explicit_telegram_calls,
            min(occurred_at) AS first_matched_at,
            max(occurred_at) AS last_matched_at,
            coalesce(
                (SELECT jsonb_object_agg(platform, count) FROM platform_counts),
                CAST('{}' AS jsonb)
            ) AS matched_platforms
        FROM filtered
        """
    ).bindparams(bindparam("sources", expanding=True))
    rows_sql = text(
        cte
        + """
        SELECT
            platform,
            event_type,
            source_handle,
            source_name,
            source_url,
            text,
            occurred_at,
            metrics
        FROM filtered
        ORDER BY occurred_at DESC, id DESC
        LIMIT :limit
        """
    ).bindparams(bindparam("sources", expanding=True))

    with ANALYSIS_STAGE_RUNTIME.labels(stage="social_timeline_query").time():
        aggregate = (await session.execute(aggregate_sql, params)).mappings().one()
        retained_desc = list((await session.execute(rows_sql, params)).mappings().all())

    retained = [dict(row) for row in reversed(retained_desc)]
    ranked = [{**row, "rank": index + 1} for index, row in enumerate(retained)]
    returned_platforms = Counter(str(row.get("platform") or "unknown") for row in ranked)
    matched_before_limit = int(aggregate["matched_before_limit"] or 0)
    matched_platforms = dict(aggregate["matched_platforms"] or {})
    return {
        "mint_address": mint_address,
        "mentions": len(ranked),
        "platforms": dict(returned_platforms),
        "origin": ranked[0] if ranked else None,
        "timeline": ranked,
        "meta": {
            "matchedBeforeLimit": matched_before_limit,
            "returned": len(ranked),
            "truncated": matched_before_limit > max_items,
            "matchedPlatforms": matched_platforms,
            "uniqueSourcesBeforeLimit": int(aggregate["unique_sources"] or 0),
            "explicitTelegramCallsBeforeLimit": int(
                aggregate["explicit_telegram_calls"] or 0
            ),
            "firstMatchedAt": aggregate["first_matched_at"],
            "lastMatchedAt": aggregate["last_matched_at"],
            "queryMode": "postgresql_filtered",
        },
        "filters": {
            "platform": platform,
            "hours": hours,
            "sources": normalized_sources,
            "explicit_calls_only": explicit_calls_only,
            "min_engagement": max(0, int(min_engagement)),
            "min_channel_score": max(0.0, float(min_channel_score)),
            "limit": max_items,
        },
    }
