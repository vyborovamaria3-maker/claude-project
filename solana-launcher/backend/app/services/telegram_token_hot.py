from __future__ import annotations

from typing import Any

from sqlalchemy import String, cast, func, literal, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.social_intelligence import TelegramCall, TelegramChannel, TelegramMessage
from app.services.observability import ANALYSIS_STAGE_RUNTIME
from app.services.social_intelligence import normalize_caller_username
from app.services.telegram_signal_analysis import (
    _forwarded_from,
    _is_forwarded_payload,
    analyze_coordination_events,
    build_caller_reputation,
    token_coordination,
)


def _caller_name(
    caller_username: str | None,
    channel_username: str | None,
    telegram_id: int | None,
    channel_title: str | None,
    channel_id: int,
) -> str:
    fallback = (
        str(telegram_id)
        if telegram_id is not None
        else (channel_title or f"channel-{channel_id}")
    )
    return normalize_caller_username(caller_username or channel_username or fallback)


def _caller_sql_expression():
    # Mirror `_caller_name`/normalize_caller_username in SQL. Empty strings fall
    # through to the next identity source, while whitespace or "@" are truthy in
    # Python but normalize to the explicit "unknown" identity.
    fallback = func.coalesce(
        func.nullif(TelegramCall.caller_username, ""),
        func.nullif(TelegramChannel.username, ""),
        cast(TelegramChannel.telegram_id, String),
        func.nullif(TelegramChannel.title, ""),
        literal("channel-") + cast(TelegramChannel.id, String),
    )
    normalized = func.lower(func.ltrim(func.trim(fallback), "@"))
    return func.coalesce(func.nullif(normalized, ""), literal("unknown"))


async def relevant_caller_reputation(
    session: AsyncSession,
    *,
    usernames: set[str],
    exclude_mint: str,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Build caller reputation from history for only callers relevant to one mint."""
    normalized = {
        normalize_caller_username(username)
        for username in usernames
        if username
    }
    if not normalized:
        return []

    statement = (
        select(
            TelegramCall.caller_username,
            TelegramCall.mint_address,
            TelegramCall.called_at,
            TelegramCall.outcome,
            TelegramCall.roi_multiple,
            TelegramCall.call_market_cap_usd,
            TelegramCall.meta,
            TelegramChannel.id.label("channel_id"),
            TelegramChannel.username.label("channel_username"),
            TelegramChannel.telegram_id,
            TelegramChannel.title.label("channel_title"),
            TelegramMessage.raw.label("message_raw"),
        )
        .join(TelegramMessage, TelegramMessage.id == TelegramCall.message_id)
        .join(TelegramChannel, TelegramChannel.id == TelegramCall.channel_id)
        .where(
            TelegramCall.is_explicit_call.is_(True),
            TelegramCall.mint_address != exclude_mint,
            _caller_sql_expression().in_(sorted(normalized)),
        )
    )
    with ANALYSIS_STAGE_RUNTIME.labels(stage="caller_reputation_relevant").time():
        db_rows = (await session.execute(statement)).mappings().all()

    rows: list[dict[str, Any]] = []
    for row in db_rows:
        raw = row["message_raw"] if isinstance(row["message_raw"], dict) else {}
        username = _caller_name(
            row["caller_username"],
            row["channel_username"],
            row["telegram_id"],
            row["channel_title"],
            int(row["channel_id"]),
        )
        if username not in normalized:
            continue
        forwarded_source = _forwarded_from(raw)
        rows.append(
            {
                "username": username,
                "mint_address": row["mint_address"],
                "called_at": row["called_at"],
                "outcome": row["outcome"],
                "roi_multiple": row["roi_multiple"],
                "call_market_cap_usd": row["call_market_cap_usd"],
                "forwarded_from": (
                    forwarded_source
                    or ("__forwarded__" if _is_forwarded_payload(raw) else None)
                ),
                "meta": row["meta"] or {},
            }
        )
    reputations = build_caller_reputation(rows)
    reputations = [row for row in reputations if row["username"] in normalized]
    return reputations[: max(1, min(int(limit), 25))]


async def _postgres_token_coordination(
    session: AsyncSession,
    mint_address: str,
) -> dict[str, Any]:
    statement = text(
        """
        WITH normalized AS (
            SELECT
                source_handle,
                source_name,
                text,
                occurred_at,
                payload,
                split_part(
                    split_part(
                        split_part(
                            btrim(
                                regexp_replace(
                                    regexp_replace(
                                        lower(
                                            ltrim(
                                                btrim(
                                                    coalesce(
                                                        nullif(source_handle, ''),
                                                        source_name,
                                                        ''
                                                    )
                                                ),
                                                '@'
                                            )
                                        ),
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
                ) AS source_key
            FROM social_events
            WHERE platform = 'telegram'
              AND mint_address = :mint
        ), ranked AS (
            SELECT
                normalized.*,
                row_number() OVER (
                    PARTITION BY source_key
                    ORDER BY occurred_at ASC
                ) AS source_rank
            FROM normalized
            WHERE source_key <> ''
        )
        SELECT source_key, text, occurred_at, payload
        FROM ranked
        WHERE source_rank = 1
        ORDER BY occurred_at ASC
        """
    )
    with ANALYSIS_STAGE_RUNTIME.labels(stage="telegram_coordination_query").time():
        rows = (await session.execute(statement, {"mint": mint_address})).mappings().all()
    return analyze_coordination_events(
        {
            "source_handle": row["source_key"],
            "text": row["text"],
            "occurred_at": row["occurred_at"],
            "payload": row["payload"],
        }
        for row in rows
    )


async def token_coordination_hot(
    session: AsyncSession,
    mint_address: str,
) -> dict[str, Any]:
    dialect = session.bind.dialect.name if session.bind is not None else ""
    if dialect == "postgresql":
        return await _postgres_token_coordination(session, mint_address)
    return await token_coordination(session, mint_address)


async def telegram_token_intelligence_hot(
    session: AsyncSession,
    mint_address: str,
    *,
    caller_limit: int = 10,
) -> dict[str, Any]:
    coordination = await token_coordination_hot(session, mint_address)
    calls = list(
        (
            await session.execute(
                select(TelegramCall, TelegramChannel)
                .join(TelegramChannel, TelegramChannel.id == TelegramCall.channel_id)
                .where(
                    TelegramCall.mint_address == mint_address,
                    TelegramCall.is_explicit_call.is_(True),
                )
                .order_by(TelegramCall.called_at.asc(), TelegramCall.id.asc())
            )
        ).all()
    )

    relevant = {
        _caller_name(
            call.caller_username,
            channel.username,
            channel.telegram_id,
            channel.title,
            channel.id,
        )
        for call, channel in calls
    }
    caller_rows = (
        await relevant_caller_reputation(
            session,
            usernames=relevant,
            exclude_mint=mint_address,
            limit=max(1, min(int(caller_limit), 25)),
        )
        if relevant
        else []
    )
    caller_rows.sort(key=lambda item: item["reputation_score"], reverse=True)

    first_call = None
    if calls:
        first_at = calls[0][0].called_at
        tied = [(call, channel) for call, channel in calls if call.called_at == first_at]
        sources = sorted(
            {
                _caller_name(
                    call.caller_username,
                    channel.username,
                    channel.telegram_id,
                    channel.title,
                    channel.id,
                )
                for call, channel in tied
            }
        )
        call, _channel = calls[0]
        first_call = {
            "source": sources[0] if len(sources) == 1 else None,
            "sources": sources,
            "tied": len(sources) > 1,
            "called_at": call.called_at,
            "call_market_cap_usd": call.call_market_cap_usd,
        }
    return {
        "coordination": coordination,
        "first_call": first_call,
        "callers": caller_rows[: max(1, min(int(caller_limit), 25))],
    }
