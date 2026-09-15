from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analytics import Token, Wallet, WalletLink, WalletTrade
from app.models.kol_intelligence import KOLProfile, KOLTradeEvent, KOLWalletAttribution


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _attribution_rank(
    attribution: KOLWalletAttribution,
    profile: KOLProfile,
) -> tuple[int, float, float, int]:
    return (
        1 if attribution.verified else 0,
        float(attribution.confidence or 0.0),
        float(profile.confidence or 0.0),
        -int(profile.id or 0),
    )


def canonical_kol_event_rows(
    rows: list[tuple[KOLTradeEvent, Wallet, KOLWalletAttribution, KOLProfile]],
) -> list[tuple[KOLTradeEvent, Wallet, KOLWalletAttribution, KOLProfile]]:
    """Return one canonical identity attribution per blockchain event."""
    best_by_event: dict[int, tuple[KOLTradeEvent, Wallet, KOLWalletAttribution, KOLProfile]] = {}
    for row in rows:
        event, _wallet, attribution, profile = row
        existing = best_by_event.get(event.id)
        if existing is None or _attribution_rank(attribution, profile) > _attribution_rank(
            existing[2], existing[3]
        ):
            best_by_event[event.id] = row
    return list(best_by_event.values())


async def build_kol_token_intelligence(
    session: AsyncSession,
    mint_address: str,
) -> dict[str, Any]:
    raw_rows = list(
        (
            await session.execute(
                select(KOLTradeEvent, Wallet, KOLWalletAttribution, KOLProfile)
                .join(Wallet, Wallet.id == KOLTradeEvent.analytics_wallet_id)
                .join(
                    KOLWalletAttribution,
                    KOLWalletAttribution.analytics_wallet_id == Wallet.id,
                )
                .join(KOLProfile, KOLProfile.id == KOLWalletAttribution.kol_id)
                .where(
                    KOLTradeEvent.mint_address == mint_address,
                    KOLWalletAttribution.chain == "solana",
                    KOLWalletAttribution.confidence >= 50,
                )
            )
        ).all()
    )
    rows = canonical_kol_event_rows(raw_rows)
    if not rows:
        return {
            "status": "no_local_trade_history",
            "mint": mint_address,
            "ownership_claim": False,
            "windows": {},
            "actors": [],
        }

    now = utcnow()
    windows: dict[str, Any] = {}
    for label, delta in (
        ("1h", timedelta(hours=1)),
        ("24h", timedelta(hours=24)),
        ("7d", timedelta(days=7)),
    ):
        cutoff = now - delta
        buyers: set[str] = set()
        sellers: set[str] = set()
        buy_value = 0.0
        sell_value = 0.0
        valued_buys = 0
        valued_sells = 0
        high_confidence_buyers: set[str] = set()

        for event, _wallet, attribution, profile in rows:
            occurred_at = _as_utc(event.occurred_at)
            if occurred_at is None or occurred_at < cutoff:
                continue
            handle = profile.twitter_handle
            value = float(event.value_usd) if event.value_usd is not None else None
            if event.side == "buy":
                buyers.add(handle)
                if attribution.confidence >= 90:
                    high_confidence_buyers.add(handle)
                if value is not None and value >= 0:
                    buy_value += value
                    valued_buys += 1
            elif event.side == "sell":
                sellers.add(handle)
                if value is not None and value >= 0:
                    sell_value += value
                    valued_sells += 1

        net_flow = buy_value - sell_value if valued_buys or valued_sells else None
        ratio = (len(buyers) / max(1, len(sellers))) if buyers else 0.0
        windows[label] = {
            "buyers": len(buyers),
            "sellers": len(sellers),
            "buyer_seller_ratio": round(ratio, 3),
            "high_confidence_buyers": len(high_confidence_buyers),
            "gross_buy_value_usd": round(buy_value, 2) if valued_buys else None,
            "gross_sell_value_usd": round(sell_value, 2) if valued_sells else None,
            "net_flow_usd": round(net_flow, 2) if net_flow is not None else None,
            "handles": sorted(buyers | sellers)[:50],
            "valuation_coverage": {
                "buy_events": valued_buys,
                "sell_events": valued_sells,
            },
        }

    actor_map: dict[str, dict[str, Any]] = {}
    for event, wallet, attribution, profile in rows:
        actor = actor_map.setdefault(
            profile.twitter_handle,
            {
                "handle": profile.twitter_handle,
                "display_name": profile.display_name,
                "profile_confidence": profile.confidence,
                "verified": profile.verified,
                "wallets": set(),
                "trades": 0,
                "last_activity_at": None,
            },
        )
        actor["wallets"].add(wallet.wallet_address)
        actor["trades"] += 1
        activity = _as_utc(event.occurred_at)
        if activity and (
            actor["last_activity_at"] is None
            or activity > actor["last_activity_at"]
        ):
            actor["last_activity_at"] = activity

    actors = []
    for actor in actor_map.values():
        actors.append(
            {
                **actor,
                "wallets": sorted(actor["wallets"]),
                "last_activity_at": (
                    actor["last_activity_at"].isoformat()
                    if actor["last_activity_at"]
                    else None
                ),
            }
        )
    actors.sort(
        key=lambda item: (
            item["last_activity_at"] or "",
            item["profile_confidence"],
        ),
        reverse=True,
    )

    one_hour = windows["1h"]
    net = one_hour.get("net_flow_usd")
    if one_hour["buyers"] >= 3 and one_hour["buyer_seller_ratio"] >= 2 and (net is None or net > 0):
        signal = "kol_accumulation"
    elif one_hour["sellers"] >= 3 and one_hour["sellers"] > one_hour["buyers"] and (net is None or net < 0):
        signal = "kol_distribution"
    elif one_hour["buyers"] or one_hour["sellers"]:
        signal = "mixed_kol_activity"
    else:
        signal = "no_recent_kol_activity"

    return {
        "status": "ok",
        "mint": mint_address,
        "signal": signal,
        "ownership_claim": False,
        "attribution_note": (
            "Each on-chain KOLTradeEvent is counted once using the strongest stored identity attribution. "
            "Behavioral or related-wallet links are not treated as proof of ownership."
        ),
        "event_source": "kol_trade_events",
        "windows": windows,
        "actors": actors[:30],
    }


async def _token_participation(
    session: AsyncSession,
    wallet_ids: set[int],
) -> dict[int, set[str]]:
    token_sets: dict[int, set[str]] = {wallet_id: set() for wallet_id in wallet_ids}
    if not wallet_ids:
        return token_sets

    event_rows = (
        await session.execute(
            select(KOLTradeEvent.analytics_wallet_id, KOLTradeEvent.mint_address)
            .where(KOLTradeEvent.analytics_wallet_id.in_(wallet_ids))
            .distinct()
        )
    ).all()
    for wallet_id, mint in event_rows:
        token_sets.setdefault(int(wallet_id), set()).add(str(mint))

    missing = {wallet_id for wallet_id, tokens in token_sets.items() if not tokens}
    if missing:
        legacy_rows = (
            await session.execute(
                select(WalletTrade.wallet_id, Token.mint_address)
                .join(Token, Token.id == WalletTrade.token_id)
                .where(WalletTrade.wallet_id.in_(missing))
                .distinct()
            )
        ).all()
        for wallet_id, mint in legacy_rows:
            token_sets.setdefault(int(wallet_id), set()).add(str(mint))
    return token_sets


async def related_wallet_candidates(
    session: AsyncSession,
    wallet_address: str,
    *,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Return behavioral wallet candidates using bounded Jaccard token overlap.

    Event-ledger overlap is primary. Legacy wallet_links remains a candidate source
    only, because its stored counters historically inflated across refreshes. No
    behavioral candidate is presented as an ownership claim.
    """
    wallet = (
        await session.execute(
            select(Wallet).where(Wallet.wallet_address == wallet_address).limit(1)
        )
    ).scalar_one_or_none()
    if wallet is None:
        return []

    requested_limit = max(1, min(limit, 100))
    candidate_limit = min(500, max(50, requested_limit * 8))
    source_tokens = (await _token_participation(session, {wallet.id})).get(wallet.id, set())
    if not source_tokens:
        return []

    overlap_rows = (
        await session.execute(
            select(
                KOLTradeEvent.analytics_wallet_id,
                func.count(func.distinct(KOLTradeEvent.mint_address)).label("shared"),
            )
            .where(
                KOLTradeEvent.analytics_wallet_id != wallet.id,
                KOLTradeEvent.mint_address.in_(source_tokens),
            )
            .group_by(KOLTradeEvent.analytics_wallet_id)
            .order_by(func.count(func.distinct(KOLTradeEvent.mint_address)).desc())
            .limit(candidate_limit)
        )
    ).all()
    candidate_ids = {int(wallet_id) for wallet_id, _shared in overlap_rows}

    legacy_links = list(
        (
            await session.execute(
                select(WalletLink).where(
                    or_(
                        WalletLink.wallet_a_id == wallet.id,
                        WalletLink.wallet_b_id == wallet.id,
                    )
                )
                .order_by(WalletLink.similarity_score.desc())
                .limit(candidate_limit)
            )
        ).scalars().all()
    )
    legacy_by_other: dict[int, WalletLink] = {}
    for link in legacy_links:
        other_id = link.wallet_b_id if link.wallet_a_id == wallet.id else link.wallet_a_id
        candidate_ids.add(other_id)
        legacy_by_other[other_id] = link

    if not candidate_ids:
        return []
    others = {
        item.id: item
        for item in (
            await session.execute(select(Wallet).where(Wallet.id.in_(candidate_ids)))
        ).scalars().all()
    }
    token_sets = await _token_participation(session, {wallet.id, *candidate_ids})

    result: list[dict[str, Any]] = []
    for other_id in candidate_ids:
        other = others.get(other_id)
        if other is None:
            continue
        other_tokens = token_sets.get(other_id, set())
        shared_tokens = source_tokens & other_tokens
        if not shared_tokens:
            continue
        union_tokens = source_tokens | other_tokens
        similarity = len(shared_tokens) / len(union_tokens) if union_tokens else 0.0
        link = legacy_by_other.get(other_id)
        result.append(
            {
                "address": other.wallet_address,
                "similarity_score": round(max(0.0, min(1.0, similarity)), 6),
                "shared_tokens_count": len(shared_tokens),
                "first_interaction_date": (
                    link.first_interaction_date.isoformat()
                    if link and link.first_interaction_date
                    else None
                ),
                "details": {
                    **((link.details or {}) if link else {}),
                    "method": "jaccard_unique_token_participation",
                    "event_ledger_primary": True,
                    "legacy_graph_candidate": link is not None,
                    "stored_shared_tokens_count": link.shared_tokens_count if link else None,
                },
                "classification": "possible_related_wallet",
                "ownership_claim": False,
            }
        )

    result.sort(
        key=lambda item: (item["similarity_score"], item["shared_tokens_count"], item["address"]),
        reverse=True,
    )
    return result[:requested_limit]
