from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analytics import WalletTrade
from app.models.kol_intelligence import KOLWalletAttribution, KOLWalletMetric


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def trade_value(amount: float | None, price: float | None) -> float | None:
    if amount is None or price is None:
        return None
    value = float(amount) * float(price)
    return value if value >= 0 else None


async def _get_or_create_internal_metric(
    session: AsyncSession,
    *,
    wallet_id: int,
    timeframe_days: int,
) -> KOLWalletMetric:
    metric = (
        await session.execute(
            select(KOLWalletMetric).where(
                KOLWalletMetric.wallet_id == wallet_id,
                KOLWalletMetric.timeframe_days == timeframe_days,
                KOLWalletMetric.source == "internal_wallet_trades",
            ).limit(1)
        )
    ).scalar_one_or_none()
    if metric is not None:
        return metric

    candidate = KOLWalletMetric(
        wallet_id=wallet_id,
        timeframe_days=timeframe_days,
        source="internal_wallet_trades",
    )
    try:
        async with session.begin_nested():
            session.add(candidate)
            await session.flush()
        return candidate
    except IntegrityError:
        metric = (
            await session.execute(
                select(KOLWalletMetric).where(
                    KOLWalletMetric.wallet_id == wallet_id,
                    KOLWalletMetric.timeframe_days == timeframe_days,
                    KOLWalletMetric.source == "internal_wallet_trades",
                ).limit(1)
            )
        ).scalar_one_or_none()
        if metric is None:
            raise
        return metric


async def refresh_kol_metrics(session: AsyncSession) -> dict[str, int]:
    now = utcnow()
    cutoff = now - timedelta(days=30)
    rows = list(
        (
            await session.execute(
                select(KOLWalletAttribution, WalletTrade)
                .outerjoin(
                    WalletTrade,
                    and_(
                        WalletTrade.wallet_id == KOLWalletAttribution.analytics_wallet_id,
                        or_(
                            WalletTrade.buy_timestamp >= cutoff,
                            WalletTrade.sell_timestamp >= cutoff,
                        ),
                    ),
                )
                .where(
                    KOLWalletAttribution.chain == "solana",
                    KOLWalletAttribution.analytics_wallet_id.is_not(None),
                )
            )
        ).all()
    )

    grouped: dict[int, tuple[KOLWalletAttribution, list[WalletTrade]]] = {}
    for attribution, trade in rows:
        if attribution.id not in grouped:
            grouped[attribution.id] = (attribution, [])
        if trade is not None:
            grouped[attribution.id][1].append(trade)

    refreshed = 0
    for attribution, trades in grouped.values():
        for days in (1, 7, 30):
            start = now - timedelta(days=days)
            realized = 0.0
            wins = 0
            losses = 0
            volume = 0.0
            has_realized = False
            has_volume = False
            trade_count = 0
            last_trade_at: datetime | None = None

            for trade in trades:
                buy_recent = bool(trade.buy_timestamp and trade.buy_timestamp >= start)
                sell_recent = bool(trade.sell_timestamp and trade.sell_timestamp >= start)
                if not buy_recent and not sell_recent:
                    continue
                trade_count += 1
                activity = trade.sell_timestamp or trade.buy_timestamp
                if activity and (last_trade_at is None or activity > last_trade_at):
                    last_trade_at = activity
                if buy_recent:
                    value = trade_value(trade.amount_buy, trade.avg_buy_price)
                    if value is not None:
                        volume += value
                        has_volume = True
                if sell_recent:
                    value = trade_value(trade.amount_sold, trade.avg_sell_price)
                    if value is not None:
                        volume += value
                        has_volume = True
                    if trade.realized_profit_usd is not None:
                        profit = float(trade.realized_profit_usd)
                        realized += profit
                        has_realized = True
                        if profit > 0:
                            wins += 1
                        elif profit < 0:
                            losses += 1

            metric = await _get_or_create_internal_metric(
                session,
                wallet_id=attribution.id,
                timeframe_days=days,
            )
            closed = wins + losses
            metric.pnl_value = None
            metric.pnl_currency = None
            metric.realized_pnl_usd = realized if has_realized else None
            metric.unrealized_pnl_usd = None
            metric.win_rate = (wins / closed * 100) if closed else None
            metric.wins = wins if closed else None
            metric.losses = losses if closed else None
            metric.volume_usd = volume if has_volume else None
            metric.trade_count = trade_count
            metric.last_trade_at = last_trade_at
            metric.raw_payload = {
                "method": "existing_wallet_trades",
                "window_days": days,
                "stale_cleared": trade_count == 0,
            }
            metric.calculated_at = now
            refreshed += 1

    return {"wallets": len(grouped), "metrics": refreshed}
