from __future__ import annotations

from typing import Any

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analytics import Token, TokenMetric, Wallet, WalletTrade


def _latest_metric_subquery():
    metric = TokenMetric
    return (
        select(
            metric.id.label("metric_id"),
            metric.token_id.label("metric_token_id"),
            metric.timestamp.label("metric_timestamp"),
            metric.price_usd.label("metric_price_usd"),
            metric.ath_usd.label("metric_ath_usd"),
            metric.ath_date.label("metric_ath_date"),
            metric.market_cap.label("metric_market_cap"),
            metric.fdv.label("metric_fdv"),
            metric.liquidity_usd.label("metric_liquidity_usd"),
            metric.volume_24h.label("metric_volume_24h"),
            metric.tx_count_24h.label("metric_tx_count_24h"),
            metric.holder_count.label("metric_holder_count"),
            metric.twitter_url.label("metric_twitter_url"),
            metric.telegram_url.label("metric_telegram_url"),
            metric.discord_url.label("metric_discord_url"),
            metric.website_url.label("metric_website_url"),
            metric.social_engagements.label("metric_social_engagements"),
            func.row_number()
            .over(
                partition_by=metric.token_id,
                order_by=(metric.timestamp.desc(), metric.id.desc()),
            )
            .label("rn"),
        )
        .subquery("latest_metric")
    )


def _metric_payload(row, latest_metric) -> dict[str, Any] | None:
    mapping = row._mapping
    metric_id = mapping[latest_metric.c.metric_id]
    if metric_id is None:
        return None
    return {
        "id": metric_id,
        "token_id": mapping[latest_metric.c.metric_token_id],
        "timestamp": mapping[latest_metric.c.metric_timestamp],
        "price_usd": mapping[latest_metric.c.metric_price_usd],
        "ath_usd": mapping[latest_metric.c.metric_ath_usd],
        "ath_date": mapping[latest_metric.c.metric_ath_date],
        "market_cap": mapping[latest_metric.c.metric_market_cap],
        "fdv": mapping[latest_metric.c.metric_fdv],
        "liquidity_usd": mapping[latest_metric.c.metric_liquidity_usd],
        "volume_24h": mapping[latest_metric.c.metric_volume_24h],
        "tx_count_24h": mapping[latest_metric.c.metric_tx_count_24h],
        "holder_count": mapping[latest_metric.c.metric_holder_count],
        "twitter_url": mapping[latest_metric.c.metric_twitter_url],
        "telegram_url": mapping[latest_metric.c.metric_telegram_url],
        "discord_url": mapping[latest_metric.c.metric_discord_url],
        "website_url": mapping[latest_metric.c.metric_website_url],
        "social_engagements": mapping[latest_metric.c.metric_social_engagements],
    }


async def list_tokens(
    session: AsyncSession,
    limit: int,
    offset: int,
    sort_by: str = "ath",
    order: str = "desc",
) -> tuple[list[dict[str, Any]], int]:
    """Return only the requested token page, sorted inside the database.

    The previous implementation loaded every token and every latest metric into Python,
    sorted the complete dataset, and only then sliced to ``limit``. That scales linearly
    with the full token universe even when the API caller asks for 50 rows.
    """
    latest_metric = _latest_metric_subquery()
    metric_columns = [column for column in latest_metric.c if column.key != "rn"]

    total = int(await session.scalar(select(func.count()).select_from(Token)) or 0)

    sort_key = sort_by.lower()
    sort_columns = {
        "ath": latest_metric.c.metric_ath_usd,
        "volume": latest_metric.c.metric_volume_24h,
        "liquidity": latest_metric.c.metric_liquidity_usd,
        "market_cap": latest_metric.c.metric_market_cap,
        "holders": latest_metric.c.metric_holder_count,
    }
    direction_desc = order.lower() != "asc"

    statement = (
        select(Token, *metric_columns)
        .outerjoin(
            latest_metric,
            and_(
                latest_metric.c.metric_token_id == Token.id,
                latest_metric.c.rn == 1,
            ),
        )
    )

    sort_column = sort_columns.get(sort_key)
    if sort_column is None:
        primary_order = Token.id.desc() if direction_desc else Token.id.asc()
    else:
        normalized_sort = func.coalesce(sort_column, 0)
        primary_order = normalized_sort.desc() if direction_desc else normalized_sort.asc()

    tie_breaker = Token.id.desc() if direction_desc else Token.id.asc()
    statement = statement.order_by(primary_order, tie_breaker).offset(offset).limit(limit)

    rows = (await session.execute(statement)).all()
    items: list[dict[str, Any]] = []
    for row in rows:
        token = row[0]
        items.append(
            {
                "id": token.id,
                "mint_address": token.mint_address,
                "name": token.name,
                "symbol": token.symbol,
                "description": token.description,
                "creator_wallet": token.creator_wallet,
                "creation_date": token.creation_date,
                "migrated_to_raydium": token.migrated_to_raydium,
                "migration_date": token.migration_date,
                "status": token.status,
                "last_synced_at": token.last_synced_at,
                "latest_metric": _metric_payload(row, latest_metric),
            }
        )
    return items, total


async def get_wallet_activity(
    session: AsyncSession,
    wallet_address: str,
    *,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """Return a bounded trade page while computing summary values in SQL."""
    wallet = (
        await session.execute(select(Wallet).where(Wallet.wallet_address == wallet_address))
    ).scalar_one_or_none()
    if wallet is None:
        raise ValueError("Wallet not found")

    summary = (
        await session.execute(
            select(
                func.count(WalletTrade.id).label("total"),
                func.coalesce(func.sum(WalletTrade.realized_profit_usd), 0).label(
                    "profit_total"
                ),
                func.count(func.distinct(WalletTrade.token_id)).label("token_count"),
            ).where(WalletTrade.wallet_id == wallet.id)
        )
    ).one()

    trades = list(
        (
            await session.execute(
                select(WalletTrade)
                .where(WalletTrade.wallet_id == wallet.id)
                .order_by(WalletTrade.buy_timestamp.desc(), WalletTrade.id.desc())
                .offset(offset)
                .limit(limit)
            )
        ).scalars().all()
    )

    return {
        "wallet": wallet,
        "trades": trades,
        "profit_total": float(summary.profit_total or 0),
        "token_count": int(summary.token_count or 0),
        "meta": {
            "limit": limit,
            "offset": offset,
            "total": int(summary.total or 0),
        },
    }
