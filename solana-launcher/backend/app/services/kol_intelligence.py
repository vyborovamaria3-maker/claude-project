from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analytics import Token, Wallet, WalletLink, WalletTrade
from app.models.kol_intelligence import KOLProfile, KOLWalletAttribution


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _trade_value(amount: float | None, price: float | None) -> float | None:
    if amount is None or price is None:
        return None
    value = float(amount) * float(price)
    return value if value >= 0 else None


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


def canonical_kol_trade_rows(
    rows: list[tuple[WalletTrade, Wallet, KOLWalletAttribution, KOLProfile]],
) -> list[tuple[WalletTrade, Wallet, KOLWalletAttribution, KOLProfile]]:
    """Return one canonical KOL attribution per WalletTrade.

    A single analytics wallet can be linked to multiple KOL profiles. Counting the same
    WalletTrade once per attribution inflates volume/net-flow and can create false
    accumulation signals. Prefer verified/high-confidence attribution deterministically.
    """
    best_by_trade: dict[int, tuple[WalletTrade, Wallet, KOLWalletAttribution, KOLProfile]] = {}
    for row in rows:
        trade, _wallet, attribution, profile = row
        existing = best_by_trade.get(trade.id)
        if existing is None or _attribution_rank(attribution, profile) > _attribution_rank(
            existing[2], existing[3]
        ):
            best_by_trade[trade.id] = row
    return list(best_by_trade.values())


async def build_kol_token_intelligence(
    session: AsyncSession,
    mint_address: str,
) -> dict[str, Any]:
    token = (
        await session.execute(
            select(Token).where(Token.mint_address == mint_address).limit(1)
        )
    ).scalar_one_or_none()
    if token is None:
        return {
            "status": "no_local_token_history",
            "mint": mint_address,
            "ownership_claim": False,
            "windows": {},
            "actors": [],
        }

    raw_rows = list(
        (
            await session.execute(
                select(WalletTrade, Wallet, KOLWalletAttribution, KOLProfile)
                .join(Wallet, Wallet.id == WalletTrade.wallet_id)
                .join(
                    KOLWalletAttribution,
                    KOLWalletAttribution.analytics_wallet_id == Wallet.id,
                )
                .join(KOLProfile, KOLProfile.id == KOLWalletAttribution.kol_id)
                .where(
                    WalletTrade.token_id == token.id,
                    KOLWalletAttribution.confidence >= 50,
                )
            )
        ).all()
    )
    rows = canonical_kol_trade_rows(raw_rows)

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

        for trade, _wallet, attribution, profile in rows:
            handle = profile.twitter_handle
            if trade.buy_timestamp and trade.buy_timestamp >= cutoff:
                buyers.add(handle)
                if attribution.confidence >= 90:
                    high_confidence_buyers.add(handle)
                value = _trade_value(trade.amount_buy, trade.avg_buy_price)
                if value is not None:
                    buy_value += value
                    valued_buys += 1
            if trade.sell_timestamp and trade.sell_timestamp >= cutoff:
                sellers.add(handle)
                value = _trade_value(trade.amount_sold, trade.avg_sell_price)
                if value is not None:
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
                "buy_trades": valued_buys,
                "sell_trades": valued_sells,
            },
        }

    actor_map: dict[str, dict[str, Any]] = {}
    for trade, wallet, attribution, profile in rows:
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
        activity = trade.sell_timestamp or trade.buy_timestamp
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
            "Each WalletTrade is counted once using the strongest stored KOL attribution. "
            "Behavioral or related-wallet links are not treated as proof of ownership."
        ),
        "windows": windows,
        "actors": actors[:30],
    }


async def related_wallet_candidates(
    session: AsyncSession,
    wallet_address: str,
    *,
    limit: int = 20,
) -> list[dict[str, Any]]:
    wallet = (
        await session.execute(
            select(Wallet).where(Wallet.wallet_address == wallet_address).limit(1)
        )
    ).scalar_one_or_none()
    if wallet is None:
        return []

    rows = list(
        (
            await session.execute(
                select(WalletLink).where(
                    or_(
                        WalletLink.wallet_a_id == wallet.id,
                        WalletLink.wallet_b_id == wallet.id,
                    )
                )
                .order_by(WalletLink.similarity_score.desc())
                .limit(max(1, min(limit, 100)))
            )
        ).scalars().all()
    )
    other_ids = {
        row.wallet_b_id if row.wallet_a_id == wallet.id else row.wallet_a_id
        for row in rows
    }
    others = {}
    if other_ids:
        others = {
            item.id: item
            for item in (
                await session.execute(select(Wallet).where(Wallet.id.in_(other_ids)))
            ).scalars().all()
        }

    result = []
    for link in rows:
        other_id = link.wallet_b_id if link.wallet_a_id == wallet.id else link.wallet_a_id
        other = others.get(other_id)
        if other is None:
            continue
        result.append(
            {
                "address": other.wallet_address,
                "similarity_score": link.similarity_score,
                "shared_tokens_count": link.shared_tokens_count,
                "first_interaction_date": (
                    link.first_interaction_date.isoformat()
                    if link.first_interaction_date
                    else None
                ),
                "details": link.details,
                "classification": "possible_related_wallet",
                "ownership_claim": False,
            }
        )
    return result
