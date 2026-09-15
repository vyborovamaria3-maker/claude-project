from __future__ import annotations

from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kol_intelligence import KOLTradeEvent, KOLWalletAttribution, KOLWalletMetric

_METRIC_SOURCE = "internal_kol_events"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _positive(value: float | None) -> float | None:
    if value is None:
        return None
    parsed = float(value)
    return parsed if parsed > 0 else None


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
                KOLWalletMetric.source == _METRIC_SOURCE,
            ).limit(1)
        )
    ).scalar_one_or_none()
    if metric is not None:
        return metric

    candidate = KOLWalletMetric(
        wallet_id=wallet_id,
        timeframe_days=timeframe_days,
        source=_METRIC_SOURCE,
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
                    KOLWalletMetric.source == _METRIC_SOURCE,
                ).limit(1)
            )
        ).scalar_one_or_none()
        if metric is None:
            raise
        return metric


def _fifo_realized(events: list[KOLTradeEvent]) -> dict[int, float | None]:
    """Return realized USD PnL for fully costed sell events.

    Lots are maintained per token. A sell only receives a realized PnL value when
    its entire amount can be matched to earlier buys and every matched buy plus the
    sell itself has a USD price. This prevents partial history/price coverage from
    silently understating cost basis.
    """
    lots: dict[str, deque[list[float | None]]] = defaultdict(deque)
    realized_by_event: dict[int, float | None] = {}
    epsilon = 1e-12

    for event in events:
        amount = _positive(event.amount)
        if amount is None:
            if event.side == "sell":
                realized_by_event[event.id] = None
            continue
        price = _positive(event.price_usd)
        if event.side == "buy":
            lots[event.mint_address].append([amount, price])
            continue
        if event.side != "sell":
            continue

        remaining = amount
        matched = 0.0
        priced = 0.0
        profit = 0.0
        queue = lots[event.mint_address]
        while remaining > epsilon and queue:
            lot = queue[0]
            lot_amount = float(lot[0] or 0.0)
            lot_price = lot[1]
            if lot_amount <= epsilon:
                queue.popleft()
                continue
            used = min(remaining, lot_amount)
            matched += used
            if price is not None and lot_price is not None:
                profit += used * (price - float(lot_price))
                priced += used
            remaining -= used
            lot_amount -= used
            if lot_amount <= epsilon:
                queue.popleft()
            else:
                lot[0] = lot_amount

        fully_matched = matched + epsilon >= amount
        fully_priced = priced + epsilon >= amount
        realized_by_event[event.id] = profit if fully_matched and fully_priced else None

    return realized_by_event


async def refresh_kol_metrics(session: AsyncSession) -> dict[str, int]:
    now = utcnow()
    attributions = list(
        (
            await session.execute(
                select(KOLWalletAttribution).where(
                    KOLWalletAttribution.chain == "solana",
                    KOLWalletAttribution.analytics_wallet_id.is_not(None),
                )
            )
        ).scalars().all()
    )
    wallet_ids = sorted(
        {
            int(attribution.analytics_wallet_id)
            for attribution in attributions
            if attribution.analytics_wallet_id is not None
        }
    )

    events_by_wallet: dict[int, list[KOLTradeEvent]] = {wallet_id: [] for wallet_id in wallet_ids}
    if wallet_ids:
        events = list(
            (
                await session.execute(
                    select(KOLTradeEvent)
                    .where(KOLTradeEvent.analytics_wallet_id.in_(wallet_ids))
                    .order_by(
                        KOLTradeEvent.analytics_wallet_id.asc(),
                        KOLTradeEvent.occurred_at.asc(),
                        KOLTradeEvent.id.asc(),
                    )
                )
            ).scalars().all()
        )
        for event in events:
            events_by_wallet.setdefault(event.analytics_wallet_id, []).append(event)

    realized_by_wallet = {
        wallet_id: _fifo_realized(events)
        for wallet_id, events in events_by_wallet.items()
    }

    refreshed = 0
    for attribution in attributions:
        analytics_wallet_id = attribution.analytics_wallet_id
        if analytics_wallet_id is None:
            continue
        events = events_by_wallet.get(int(analytics_wallet_id), [])
        realized_map = realized_by_wallet.get(int(analytics_wallet_id), {})
        for days in (1, 7, 30):
            start = now - timedelta(days=days)
            recent = [
                event
                for event in events
                if (_as_utc(event.occurred_at) or datetime.min.replace(tzinfo=timezone.utc)) >= start
            ]
            realized_total = 0.0
            realized_sell_events = 0
            unpriced_sell_events = 0
            wins = 0
            losses = 0
            last_trade_at: datetime | None = None
            transaction_values: dict[str, float] = {}
            transaction_signatures: set[str] = set()

            for event in recent:
                transaction_signatures.add(event.tx_signature)
                occurred_at = _as_utc(event.occurred_at)
                if occurred_at and (last_trade_at is None or occurred_at > last_trade_at):
                    last_trade_at = occurred_at
                value = event.value_usd
                if value is not None and float(value) >= 0:
                    parsed_value = float(value)
                    previous = transaction_values.get(event.tx_signature)
                    transaction_values[event.tx_signature] = (
                        parsed_value if previous is None else max(previous, parsed_value)
                    )
                if event.side != "sell":
                    continue
                profit = realized_map.get(event.id)
                if profit is None:
                    unpriced_sell_events += 1
                    continue
                realized_total += profit
                realized_sell_events += 1
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
            volume = sum(transaction_values.values())
            metric.pnl_value = None
            metric.pnl_currency = None
            metric.realized_pnl_usd = realized_total if realized_sell_events else None
            metric.unrealized_pnl_usd = None
            metric.win_rate = (wins / closed * 100) if closed else None
            metric.wins = wins if closed else None
            metric.losses = losses if closed else None
            metric.volume_usd = volume if transaction_values else None
            metric.trade_count = len(transaction_signatures)
            metric.last_trade_at = last_trade_at
            metric.raw_payload = {
                "method": "fifo_kol_trade_events",
                "window_days": days,
                "realized_sell_events": realized_sell_events,
                "unpriced_or_unmatched_sell_events": unpriced_sell_events,
                "valued_transactions": len(transaction_values),
                "event_count": len(recent),
                "transaction_count": len(transaction_signatures),
                "history_event_count": len(events),
                "stale_cleared": len(recent) == 0,
            }
            metric.calculated_at = now
            refreshed += 1

    return {"wallets": len(wallet_ids), "metrics": refreshed}
