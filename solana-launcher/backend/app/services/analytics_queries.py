from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import noload

from app.models.analytics import Token, TokenLatestMetric, Wallet, WalletTrade


def _metric_payload(metric: TokenLatestMetric | None) -> dict[str, Any] | None:
    if metric is None:
        return None
    return {
        "id": metric.metric_id,
        "token_id": metric.token_id,
        "timestamp": metric.timestamp,
        "price_usd": metric.price_usd,
        "ath_usd": metric.ath_usd,
        "ath_date": metric.ath_date,
        "market_cap": metric.market_cap,
        "fdv": metric.fdv,
        "liquidity_usd": metric.liquidity_usd,
        "volume_24h": metric.volume_24h,
        "tx_count_24h": metric.tx_count_24h,
        "holder_count": metric.holder_count,
        "twitter_url": metric.twitter_url,
        "telegram_url": metric.telegram_url,
        "discord_url": metric.discord_url,
        "website_url": metric.website_url,
        "social_engagements": metric.social_engagements,
    }


async def list_tokens(
    session: AsyncSession,
    limit: int,
    offset: int,
    sort_by: str = "ath",
    order: str = "desc",
) -> tuple[list[dict[str, Any]], int]:
    """Read the requested page from the one-row-per-token hot state.

    Historical ``token_metrics`` is no longer scanned or window-ranked on every
    dashboard request. The latest row is maintained when a TokenMetric is inserted.
    """
    total = int(await session.scalar(select(func.count()).select_from(Token)) or 0)

    sort_columns = {
        "ath": TokenLatestMetric.ath_usd,
        "volume": TokenLatestMetric.volume_24h,
        "liquidity": TokenLatestMetric.liquidity_usd,
        "market_cap": TokenLatestMetric.market_cap,
        "holders": TokenLatestMetric.holder_count,
    }
    direction_desc = order.lower() != "asc"
    sort_column = sort_columns.get(sort_by.lower())

    if sort_column is None:
        primary_order = Token.id.desc() if direction_desc else Token.id.asc()
    elif direction_desc:
        primary_order = sort_column.desc().nulls_last()
    else:
        primary_order = sort_column.asc().nulls_last()

    tie_breaker = Token.id.desc() if direction_desc else Token.id.asc()
    statement = (
        select(Token, TokenLatestMetric)
        .options(noload(Token.metrics), noload(Token.trades))
        .outerjoin(TokenLatestMetric, TokenLatestMetric.token_id == Token.id)
        .order_by(primary_order, tie_breaker)
        .offset(offset)
        .limit(limit)
    )

    rows = (await session.execute(statement)).all()
    items: list[dict[str, Any]] = []
    for token, latest_metric in rows:
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
                "latest_metric": _metric_payload(latest_metric),
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
        await session.execute(
            select(Wallet)
            .options(noload(Wallet.trades))
            .where(Wallet.wallet_address == wallet_address)
        )
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
                .options(noload(WalletTrade.wallet), noload(WalletTrade.token))
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
