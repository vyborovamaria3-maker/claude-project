from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analytics import Token, Wallet, WalletLink, WalletTrade
from app.models.intelligence_memory import IntelligenceSnapshot, IntelligenceSnapshotEntity
from app.models.social_intelligence import (
    SocialEvent,
    TelegramCall,
    TelegramChannel,
    TelegramChannelScore,
)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _handle(value: str) -> str:
    return value.strip().lower().lstrip("@")


def _entity_value(entity_key: str) -> str:
    return (entity_key.split(":", 1)[1] if ":" in entity_key else entity_key).strip()


def _explicit_funding(details: dict[str, Any] | None) -> dict[str, Any] | None:
    """Return only collector-stored funding evidence, never infer it from similarity."""
    if not isinstance(details, dict):
        return None
    keys = {
        "funded_by",
        "funding_source",
        "funding_wallet",
        "funding_tx",
        "funding_signature",
        "transfer_signature",
        "transfer_lamports",
        "transfer_sol",
    }
    evidence = {
        key: details[key]
        for key in keys
        if key in details and details[key] not in (None, "")
    }
    nested = details.get("funding")
    if isinstance(nested, dict) and nested:
        evidence["funding"] = nested
    return evidence or None


async def _wallet_and_links(
    session: AsyncSession,
    address: str,
    *,
    link_limit: int,
) -> tuple[Wallet | None, list[WalletLink], dict[int, str]]:
    wallet = (
        await session.execute(select(Wallet).where(Wallet.wallet_address == address))
    ).scalar_one_or_none()
    if wallet is None:
        return None, [], {}
    links = list(
        (
            await session.execute(
                select(WalletLink)
                .where(
                    or_(
                        WalletLink.wallet_a_id == wallet.id,
                        WalletLink.wallet_b_id == wallet.id,
                    )
                )
                .order_by(
                    WalletLink.similarity_score.desc(),
                    WalletLink.shared_tokens_count.desc(),
                )
                .limit(max(1, min(link_limit, 100)))
            )
        ).scalars().all()
    )
    peer_ids = {
        link.wallet_b_id if link.wallet_a_id == wallet.id else link.wallet_a_id
        for link in links
    }
    peers: dict[int, str] = {}
    if peer_ids:
        rows = list(
            (
                await session.execute(select(Wallet).where(Wallet.id.in_(peer_ids)))
            ).scalars().all()
        )
        peers = {row.id: row.wallet_address for row in rows}
    return wallet, links, peers


async def expand_wallet(
    session: AsyncSession,
    entity_key: str,
    *,
    trade_limit: int = 80,
    link_limit: int = 40,
) -> dict[str, Any]:
    address = _entity_value(entity_key)
    wallet, links, peers = await _wallet_and_links(
        session,
        address,
        link_limit=link_limit,
    )
    if wallet is None:
        return {"tool": "expand_wallet", "entity_key": entity_key, "found": False}

    trade_rows = (
        await session.execute(
            select(WalletTrade, Token)
            .join(Token, Token.id == WalletTrade.token_id)
            .where(WalletTrade.wallet_id == wallet.id)
            .order_by(WalletTrade.buy_timestamp.desc())
            .limit(max(1, min(trade_limit, 200)))
        )
    ).all()
    realized = [
        float(trade.realized_profit_usd)
        for trade, _ in trade_rows
        if trade.realized_profit_usd is not None
    ]
    wallet_links = []
    for link in links:
        peer_id = link.wallet_b_id if link.wallet_a_id == wallet.id else link.wallet_a_id
        wallet_links.append(
            {
                "peer": peers.get(peer_id),
                "shared_tokens": link.shared_tokens_count,
                "similarity": link.similarity_score,
                "first_interaction_at": _iso(link.first_interaction_date),
                "funding_evidence": _explicit_funding(link.details),
            }
        )
    return {
        "tool": "expand_wallet",
        "entity_key": entity_key,
        "found": True,
        "wallet": {
            "address": wallet.wallet_address,
            "first_seen_at": _iso(wallet.first_seen_date),
            "tags": wallet.tags or [],
            "tokens_traded": len({token.mint_address for _, token in trade_rows}),
            "trades_returned": len(trade_rows),
            "realized_profit_usd": sum(realized) if realized else None,
        },
        "trades": [
            {
                "mint": token.mint_address,
                "symbol": token.symbol,
                "buy_at": _iso(trade.buy_timestamp),
                "sell_at": _iso(trade.sell_timestamp),
                "realized_profit_usd": trade.realized_profit_usd,
                "still_holding": trade.still_holding,
            }
            for trade, token in trade_rows
        ],
        "wallet_links": wallet_links,
    }


async def funding_graph(
    session: AsyncSession,
    entity_key: str,
    *,
    limit: int = 60,
) -> dict[str, Any]:
    address = _entity_value(entity_key)
    wallet, links, peers = await _wallet_and_links(session, address, link_limit=limit)
    if wallet is None:
        return {"tool": "funding_graph", "entity_key": entity_key, "found": False}

    explicit: list[dict[str, Any]] = []
    similarity: list[dict[str, Any]] = []
    for link in links:
        peer_id = link.wallet_b_id if link.wallet_a_id == wallet.id else link.wallet_a_id
        item = {
            "source": address,
            "target": peers.get(peer_id),
            "shared_tokens": link.shared_tokens_count,
            "similarity": link.similarity_score,
            "first_interaction_at": _iso(link.first_interaction_date),
        }
        evidence = _explicit_funding(link.details)
        if evidence:
            explicit.append({**item, "evidence": evidence})
        else:
            similarity.append(item)
    return {
        "tool": "funding_graph",
        "entity_key": entity_key,
        "found": True,
        "funding_evidence_available": bool(explicit),
        "verified_funding_edges": explicit,
        "similarity_links_not_funding_proof": similarity,
    }


async def expand_x_account(
    session: AsyncSession,
    entity_key: str,
    *,
    event_limit: int = 100,
) -> dict[str, Any]:
    handle = _handle(_entity_value(entity_key))
    rows = list(
        (
            await session.execute(
                select(SocialEvent)
                .where(
                    SocialEvent.platform == "x",
                    func.lower(func.replace(SocialEvent.source_handle, "@", "")) == handle,
                )
                .order_by(SocialEvent.occurred_at.desc())
                .limit(max(1, min(event_limit, 250)))
            )
        ).scalars().all()
    )
    if not rows:
        return {"tool": "expand_x_account", "entity_key": entity_key, "found": False}
    mints = {row.mint_address for row in rows if row.mint_address}
    return {
        "tool": "expand_x_account",
        "entity_key": entity_key,
        "found": True,
        "account": {
            "handle": handle,
            "events_returned": len(rows),
            "distinct_mints": len(mints),
            "first_seen_at": _iso(min(row.occurred_at for row in rows)),
            "last_seen_at": _iso(max(row.occurred_at for row in rows)),
            "note": "Engagement/profile metrics are current observations and may be mutable.",
        },
        "recent_mentions": [
            {
                "mint": row.mint_address,
                "symbol": row.symbol,
                "occurred_at": _iso(row.occurred_at),
                "event_type": row.event_type,
                "text": row.text[:500],
                "metrics": row.metrics or {},
            }
            for row in rows[:60]
        ],
    }


async def expand_tg_channel(
    session: AsyncSession,
    entity_key: str,
    *,
    call_limit: int = 100,
) -> dict[str, Any]:
    handle = _handle(_entity_value(entity_key))
    channel = (
        await session.execute(
            select(TelegramChannel).where(
                or_(
                    func.lower(func.replace(TelegramChannel.username, "@", "")) == handle,
                    func.lower(TelegramChannel.title) == handle,
                )
            )
        )
    ).scalar_one_or_none()
    if channel is None:
        return {"tool": "expand_tg_channel", "entity_key": entity_key, "found": False}
    score = await session.get(TelegramChannelScore, channel.id)
    calls = list(
        (
            await session.execute(
                select(TelegramCall)
                .where(TelegramCall.channel_id == channel.id)
                .order_by(TelegramCall.called_at.desc())
                .limit(max(1, min(call_limit, 250)))
            )
        ).scalars().all()
    )
    return {
        "tool": "expand_tg_channel",
        "entity_key": entity_key,
        "found": True,
        "channel": {
            "id": channel.id,
            "username": channel.username,
            "title": channel.title,
            "participants": channel.participants,
            "first_seen_at": _iso(channel.first_seen_at),
            "last_seen_at": _iso(channel.last_seen_at),
            "score": score.score if score else None,
            "calls_count": score.calls_count if score else len(calls),
            "evaluated_calls": score.evaluated_calls if score else None,
            "win_rate": score.win_rate if score else None,
            "rug_rate": score.rug_rate if score else None,
            "avg_roi": score.avg_roi if score else None,
        },
        "recent_calls": [
            {
                "mint": call.mint_address,
                "called_at": _iso(call.called_at),
                "explicit": call.is_explicit_call,
                "call_market_cap_usd": call.call_market_cap_usd,
                "roi_multiple": call.roi_multiple,
                "outcome": call.outcome,
            }
            for call in calls
        ],
    }


async def related_launches(
    session: AsyncSession,
    entity_key: str,
    *,
    exclude_mint: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    rows = (
        await session.execute(
            select(IntelligenceSnapshot, IntelligenceSnapshotEntity)
            .join(
                IntelligenceSnapshotEntity,
                IntelligenceSnapshotEntity.snapshot_id == IntelligenceSnapshot.snapshot_id,
            )
            .where(IntelligenceSnapshotEntity.entity_key == entity_key)
            .order_by(IntelligenceSnapshot.created_at.desc())
            .limit(max(1, min(limit * 4, 200)))
        )
    ).all()
    seen: set[str] = set()
    launches: list[dict[str, Any]] = []
    for snap, observed in rows:
        if exclude_mint and snap.mint_address == exclude_mint:
            continue
        if snap.mint_address in seen:
            continue
        seen.add(snap.mint_address)
        launches.append(
            {
                "mint": snap.mint_address,
                "symbol": snap.symbol,
                "token_name": snap.token_name,
                "snapshot_id": snap.snapshot_id,
                "observed_as": observed.entity_type,
                "overall_confidence": snap.overall_confidence,
                "created_at": _iso(snap.created_at),
            }
        )
        if len(launches) >= limit:
            break
    return {
        "tool": "related_launches",
        "entity_key": entity_key,
        "found": bool(launches),
        "launches": launches,
    }


async def execute_research_tools(
    session: AsyncSession,
    *,
    entity_keys: list[str],
    current_mint: str | None,
    max_entities: int = 8,
) -> dict[str, Any]:
    keys = list(dict.fromkeys(key[:160] for key in entity_keys if key))[:max_entities]
    results: list[dict[str, Any]] = []
    for key in keys:
        if key.startswith("wallet:"):
            results.append(await expand_wallet(session, key))
            results.append(await funding_graph(session, key))
        elif key.startswith("x_account:"):
            results.append(await expand_x_account(session, key))
        elif key.startswith("tg_channel:"):
            results.append(await expand_tg_channel(session, key))
        results.append(await related_launches(session, key, exclude_mint=current_mint))
    return {
        "entities_requested": keys,
        "tool_calls": len(results),
        "results": results,
    }
