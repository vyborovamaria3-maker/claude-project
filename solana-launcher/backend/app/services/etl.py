from __future__ import annotations

import asyncio
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.models.analytics import CollectorJob, Token, TokenMetric, TokenStatus, Wallet, WalletLink, WalletTrade
from app.services.cache import cache_json, read_json_cache
from app.services.observability import ETL_ERRORS, ETL_RUNTIME, TOKENS_PROCESSED, WALLET_LINKS_CREATED


@dataclass(slots=True)
class TokenSourcePayload:
    mint_address: str
    name: str | None = None
    symbol: str | None = None
    description: str | None = None
    creator_wallet: str | None = None
    creation_date: datetime | None = None
    migrated_to_raydium: bool = False
    migration_date: datetime | None = None
    status: str = TokenStatus.ACTIVE.value


@dataclass(slots=True)
class TokenMetricPayload:
    timestamp: datetime
    price_usd: float | None = None
    ath_usd: float | None = None
    ath_date: datetime | None = None
    market_cap: float | None = None
    fdv: float | None = None
    liquidity_usd: float | None = None
    volume_24h: float | None = None
    tx_count_24h: int | None = None
    holder_count: int | None = None
    twitter_url: str | None = None
    telegram_url: str | None = None
    discord_url: str | None = None
    website_url: str | None = None
    social_engagements: dict[str, Any] | None = None


@dataclass(slots=True)
class TradePayload:
    wallet_address: str
    mint_address: str
    buy_timestamp: datetime
    sell_timestamp: datetime | None
    amount_buy: float
    amount_sold: float
    avg_buy_price: float | None
    avg_sell_price: float | None
    realized_profit_usd: float | None
    still_holding: bool
    extra: dict[str, Any] | None = None


async def _request_json(url: str, headers: dict[str, str] | None = None, timeout: float = 20.0) -> Any:
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.get(url, headers=headers)
        response.raise_for_status()
        return response.json()


async def fetch_pumpfun_tokens(settings: Settings | None = None) -> list[TokenSourcePayload]:
    settings = settings or get_settings()
    cache_key = "pumpfun:tokens:active"
    cached = await read_json_cache(cache_key)
    if cached is not None:
        return [TokenSourcePayload(**item) for item in cached]

    url = f"{settings.pumpfun_api_base.rstrip('/')}/coins"
    payload = await _request_json(url)
    tokens: list[TokenSourcePayload] = []
    for item in payload if isinstance(payload, list) else payload.get("coins", []):
        tokens.append(
            TokenSourcePayload(
                mint_address=item.get("mint") or item.get("mintAddress") or item.get("address"),
                name=item.get("name"),
                symbol=item.get("symbol") or item.get("ticker"),
                description=item.get("description"),
                creator_wallet=item.get("creator") or item.get("creatorWallet"),
                creation_date=_parse_datetime(item.get("createdAt") or item.get("creationDate")),
                migrated_to_raydium=bool(item.get("migrated") or item.get("isMigrated")),
                migration_date=_parse_datetime(item.get("migrationDate")),
                status=(TokenStatus.MIGRATED.value if item.get("migrated") else TokenStatus.ACTIVE.value),
            )
        )
    await cache_json(cache_key, [item.__dict__ for item in tokens], ttl_seconds=60)
    return tokens


async def fetch_raydium_pools(settings: Settings | None = None) -> list[dict[str, Any]]:
    settings = settings or get_settings()
    cache_key = "raydium:pools:v1"
    cached = await read_json_cache(cache_key)
    if cached is not None:
        return list(cached)

    url = f"{settings.raydium_api_base.rstrip('/')}/amm/pools"
    payload = await _request_json(url)
    pools = payload if isinstance(payload, list) else payload.get("data", payload.get("pools", []))
    await cache_json(cache_key, pools, ttl_seconds=120)
    return list(pools)


async def fetch_birdeye_metrics(mint_address: str, settings: Settings | None = None) -> dict[str, Any]:
    settings = settings or get_settings()
    cache_key = f"birdeye:metrics:{mint_address}"
    cached = await read_json_cache(cache_key)
    if cached is not None:
        return dict(cached)

    headers = {"X-API-KEY": settings.birdeye_api_key} if settings.birdeye_api_key else None
    base = settings.birdeye_api_base.rstrip("/")
    urls = {
        "price": f"{base}/defi/price?address={mint_address}",
        "ohlcv": f"{base}/defi/ohlcv?address={mint_address}&type=1H",
        "holders": f"{base}/token/holder?address={mint_address}",
    }
    result: dict[str, Any] = {}
    for key, url in urls.items():
        try:
            result[key] = await _request_json(url, headers=headers)
        except Exception as exc:  # pragma: no cover - remote API failure path
            result[key] = {"error": str(exc)}
    await cache_json(cache_key, result, ttl_seconds=60)
    return result


async def fetch_social_links_from_source(mint_address: str, settings: Settings | None = None) -> dict[str, str | None]:
    settings = settings or get_settings()
    cache_key = f"social-links:{mint_address}"
    cached = await read_json_cache(cache_key)
    if cached is not None:
        return dict(cached)

    # Lightweight, provider-agnostic placeholder: in production this can be replaced with
    # token metadata parsers from Pump.fun/Raydium/Helius and X/Twitter scrapers.
    links = {
        "twitter_url": None,
        "telegram_url": None,
        "discord_url": None,
        "website_url": None,
    }
    await cache_json(cache_key, links, ttl_seconds=600)
    return links


async def upsert_token(session: AsyncSession, payload: TokenSourcePayload) -> Token:
    statement = select(Token).where(Token.mint_address == payload.mint_address)
    result = await session.execute(statement)
    token = result.scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if token is None:
        token = Token(
            mint_address=payload.mint_address,
            name=payload.name,
            symbol=payload.symbol,
            description=payload.description,
            creator_wallet=payload.creator_wallet,
            creation_date=payload.creation_date,
            migrated_to_raydium=payload.migrated_to_raydium,
            migration_date=payload.migration_date,
            status=payload.status,
            last_synced_at=now,
        )
        session.add(token)
    else:
        token.name = payload.name or token.name
        token.symbol = payload.symbol or token.symbol
        token.description = payload.description or token.description
        token.creator_wallet = payload.creator_wallet or token.creator_wallet
        token.creation_date = payload.creation_date or token.creation_date
        token.migrated_to_raydium = payload.migrated_to_raydium or token.migrated_to_raydium
        token.migration_date = payload.migration_date or token.migration_date
        token.status = payload.status or token.status
        token.last_synced_at = now
    await session.flush()
    return token


async def upsert_wallet(session: AsyncSession, wallet_address: str, *, first_seen_date: datetime | None = None, tags: list[str] | None = None) -> Wallet:
    statement = select(Wallet).where(Wallet.wallet_address == wallet_address)
    result = await session.execute(statement)
    wallet = result.scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if wallet is None:
        wallet = Wallet(wallet_address=wallet_address, first_seen_date=first_seen_date, tags=tags or [], created_at=now, updated_at=now)
        session.add(wallet)
    else:
        if first_seen_date and wallet.first_seen_date is None:
            wallet.first_seen_date = first_seen_date
        if tags:
            existing = set(wallet.tags or [])
            wallet.tags = sorted(existing.union(tags))
        wallet.updated_at = now
    await session.flush()
    return wallet


async def add_token_metric(session: AsyncSession, token_id: int, payload: TokenMetricPayload) -> TokenMetric:
    metric = TokenMetric(token_id=token_id, **payload.__dict__)
    session.add(metric)
    await session.flush()
    return metric


async def upsert_trade(session: AsyncSession, payload: TradePayload) -> WalletTrade:
    wallet = await upsert_wallet(session, payload.wallet_address)
    token = await session.execute(select(Token).where(Token.mint_address == payload.mint_address))
    token_row = token.scalar_one_or_none()
    if token_row is None:
        raise ValueError(f"Token {payload.mint_address} not found")

    statement = select(WalletTrade).where(
        WalletTrade.wallet_id == wallet.id,
        WalletTrade.token_id == token_row.id,
        WalletTrade.buy_timestamp == payload.buy_timestamp,
    )
    result = await session.execute(statement)
    trade = result.scalar_one_or_none()
    if trade is None:
        trade = WalletTrade(
            wallet_id=wallet.id,
            token_id=token_row.id,
            buy_timestamp=payload.buy_timestamp,
            sell_timestamp=payload.sell_timestamp,
            amount_buy=payload.amount_buy,
            amount_sold=payload.amount_sold,
            avg_buy_price=payload.avg_buy_price,
            avg_sell_price=payload.avg_sell_price,
            realized_profit_usd=payload.realized_profit_usd,
            still_holding=payload.still_holding,
            extra=payload.extra,
        )
        session.add(trade)
    else:
        trade.sell_timestamp = payload.sell_timestamp
        trade.amount_buy = payload.amount_buy
        trade.amount_sold = payload.amount_sold
        trade.avg_buy_price = payload.avg_buy_price
        trade.avg_sell_price = payload.avg_sell_price
        trade.realized_profit_usd = payload.realized_profit_usd
        trade.still_holding = payload.still_holding
        trade.extra = payload.extra
    await session.flush()
    return trade


async def ensure_job(session: AsyncSession, job_name: str, status: str = "pending") -> CollectorJob:
    result = await session.execute(select(CollectorJob).where(CollectorJob.job_name == job_name))
    job = result.scalar_one_or_none()
    now = datetime.now(timezone.utc)
    if job is None:
        job = CollectorJob(job_name=job_name, status=status, last_run=None, meta={}, created_at=now, updated_at=now)
        session.add(job)
    else:
        job.status = status
        job.updated_at = now
    await session.flush()
    return job


async def mark_job(session: AsyncSession, job_name: str, status: str, meta: dict[str, Any] | None = None) -> CollectorJob:
    job = await ensure_job(session, job_name, status=status)
    job.status = status
    job.last_run = datetime.now(timezone.utc)
    job.meta = meta or {}
    job.updated_at = datetime.now(timezone.utc)
    await session.flush()
    return job


async def sync_pumpfun_tokens(session: AsyncSession, settings: Settings | None = None) -> int:
    settings = settings or get_settings()
    tokens = await fetch_pumpfun_tokens(settings)
    count = 0
    for payload in tokens:
        if not payload.mint_address:
            continue
        await upsert_token(session, payload)
        count += 1
    TOKENS_PROCESSED.inc(count)
    return count


async def sync_metrics_for_active_tokens(session: AsyncSession, settings: Settings | None = None) -> int:
    settings = settings or get_settings()
    result = await session.execute(select(Token).where(Token.status == TokenStatus.ACTIVE.value))
    tokens = list(result.scalars().all())
    count = 0
    for token in tokens:
        metrics = await fetch_birdeye_metrics(token.mint_address, settings)
        social_links = await fetch_social_links_from_source(token.mint_address, settings)
        price_payload = metrics.get("price", {})
        price_data = price_payload.get("data") or price_payload.get("data", {})
        if isinstance(price_data, dict):
            price_value = price_data.get("value") or price_data.get("price") or price_data.get("priceUsd")
        else:
            price_value = None
        metric_payload = TokenMetricPayload(
            timestamp=datetime.now(timezone.utc),
            price_usd=_to_float(price_value),
            ath_usd=_to_float(price_value),
            ath_date=datetime.now(timezone.utc),
            market_cap=_to_float(_extract_number(metrics, ["marketCap", "market_cap", "fdv"])),
            fdv=_to_float(_extract_number(metrics, ["fdv", "fullyDilutedValuation"])),
            liquidity_usd=_to_float(_extract_number(metrics, ["liquidity", "liquidityUsd"])),
            volume_24h=_to_float(_extract_number(metrics, ["volume24h", "volume_24h"])),
            tx_count_24h=_to_int(_extract_number(metrics, ["txCount24h", "tx_count_24h"])),
            holder_count=_to_int(_extract_number(metrics, ["holderCount", "holder_count"])),
            twitter_url=social_links.get("twitter_url"),
            telegram_url=social_links.get("telegram_url"),
            discord_url=social_links.get("discord_url"),
            website_url=social_links.get("website_url"),
            social_engagements=metrics,
        )
        await add_token_metric(session, token.id, metric_payload)
        count += 1
    TOKENS_PROCESSED.inc(count)
    return count


async def sync_wallet_links_and_top_wallets(session: AsyncSession) -> int:
    tokens_result = await session.execute(select(Token.id))
    token_ids = [row[0] for row in tokens_result.all()]
    if not token_ids:
        return 0

    wallet_rows = await session.execute(select(Wallet.id))
    wallet_ids = [row[0] for row in wallet_rows.all()]
    if len(wallet_ids) < 2:
        return 0

    # Simple first-pass cluster builder based on shared token participation.
    trade_rows = await session.execute(
        select(WalletTrade.wallet_id, WalletTrade.token_id, WalletTrade.buy_timestamp).where(WalletTrade.token_id.in_(token_ids))
    )
    token_to_wallets: dict[int, set[int]] = defaultdict(set)
    token_to_first_seen: dict[int, datetime] = {}
    for wallet_id, token_id, buy_timestamp in trade_rows.all():
        token_to_wallets[int(token_id)].add(int(wallet_id))
        token_to_first_seen[token_id] = min(token_to_first_seen.get(token_id, buy_timestamp), buy_timestamp) if token_id in token_to_first_seen else buy_timestamp

    created = 0
    for token_id, wallets in token_to_wallets.items():
        wallets_list = sorted(wallets)
        for i, wallet_a_id in enumerate(wallets_list):
            for wallet_b_id in wallets_list[i + 1 :]:
                if wallet_a_id == wallet_b_id:
                    continue
                existing = await session.execute(
                    select(WalletLink).where(
                        WalletLink.wallet_a_id == wallet_a_id,
                        WalletLink.wallet_b_id == wallet_b_id,
                    )
                )
                link = existing.scalar_one_or_none()
                if link is None:
                    link = WalletLink(
                        wallet_a_id=wallet_a_id,
                        wallet_b_id=wallet_b_id,
                        shared_tokens_count=1,
                        first_interaction_date=token_to_first_seen.get(token_id),
                        similarity_score=1.0,
                        details={"token_id": token_id},
                    )
                    session.add(link)
                    created += 1
                else:
                    link.shared_tokens_count += 1
                    link.first_interaction_date = min(filter(None, [link.first_interaction_date, token_to_first_seen.get(token_id)])) if token_to_first_seen.get(token_id) else link.first_interaction_date
                    link.similarity_score = float(link.shared_tokens_count)
                    link.details = {**(link.details or {}), "last_token_id": token_id}
    WALLET_LINKS_CREATED.inc(created)
    return created


async def run_full_collection(session: AsyncSession, settings: Settings | None = None) -> dict[str, int]:
    settings = settings or get_settings()
    async with ETL_RUNTIME.time():
        try:
            tokens = await sync_pumpfun_tokens(session, settings)
            metrics = await sync_metrics_for_active_tokens(session, settings)
            links = await sync_wallet_links_and_top_wallets(session)
            await session.commit()
            return {"tokens": tokens, "metrics": metrics, "links": links}
        except Exception:
            ETL_ERRORS.inc()
            await session.rollback()
            raise


async def list_tokens(session: AsyncSession, limit: int, offset: int, sort_by: str = "ath", order: str = "desc") -> tuple[list[dict[str, Any]], int]:
    metric = TokenMetric
    latest_metric = (
        select(
            metric.id,
            metric.token_id,
            metric.price_usd,
            metric.ath_usd,
            metric.ath_date,
            metric.market_cap,
            metric.fdv,
            metric.liquidity_usd,
            metric.volume_24h,
            metric.tx_count_24h,
            metric.holder_count,
            metric.twitter_url,
            metric.telegram_url,
            metric.discord_url,
            metric.website_url,
            metric.social_engagements,
            func.row_number().over(partition_by=metric.token_id, order_by=metric.timestamp.desc()).label("rn"),
        ).subquery()
    )

    total = await session.scalar(select(func.count()).select_from(Token)) or 0
    tokens_result = await session.execute(select(Token).order_by(Token.id.asc()))
    tokens = list(tokens_result.scalars().all())

    latest_result = await session.execute(
        select(latest_metric).where(latest_metric.c.rn == 1, latest_metric.c.token_id.in_([token.id for token in tokens]))
    )
    latest_map = {int(row.token_id): dict(row._mapping) for row in latest_result.all()}

    items: list[dict[str, Any]] = []
    for token in tokens:
        latest = latest_map.get(token.id)
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
                "latest_metric": latest,
            }
        )

    sort_key = sort_by.lower()
    reverse = order.lower() != "asc"
    if sort_key == "ath":
        items.sort(key=lambda item: (item.get("latest_metric") or {}).get("ath_usd") or 0, reverse=reverse)
    elif sort_key == "volume":
        items.sort(key=lambda item: (item.get("latest_metric") or {}).get("volume_24h") or 0, reverse=reverse)
    elif sort_key == "liquidity":
        items.sort(key=lambda item: (item.get("latest_metric") or {}).get("liquidity_usd") or 0, reverse=reverse)
    else:
        items.sort(key=lambda item: item["id"], reverse=reverse)
    return items[offset : offset + limit], int(total)


async def get_token_analysis(session: AsyncSession, mint_address: str) -> dict[str, Any]:
    token_result = await session.execute(select(Token).where(Token.mint_address == mint_address))
    token = token_result.scalar_one_or_none()
    if token is None:
        raise ValueError("Token not found")

    metrics_result = await session.execute(
        select(TokenMetric).where(TokenMetric.token_id == token.id).order_by(TokenMetric.timestamp.desc()).limit(100)
    )
    metrics = list(metrics_result.scalars().all())

    top_wallets_result = await session.execute(
        select(
            Wallet.wallet_address,
            func.sum(func.coalesce(WalletTrade.realized_profit_usd, 0)).label("profit_total"),
            func.count(WalletTrade.id).label("trades_count"),
        )
        .join(WalletTrade, Wallet.id == WalletTrade.wallet_id)
        .where(WalletTrade.token_id == token.id)
        .group_by(Wallet.id)
        .order_by(text("profit_total DESC"))
        .limit(20)
    )
    top_wallets = [dict(row._mapping) for row in top_wallets_result.all()]

    history = [
        {
            "timestamp": metric.timestamp,
            "price_usd": metric.price_usd,
            "ath_usd": metric.ath_usd,
            "market_cap": metric.market_cap,
            "fdv": metric.fdv,
            "volume_24h": metric.volume_24h,
            "liquidity_usd": metric.liquidity_usd,
        }
        for metric in metrics
    ]
    social_links = {
        "twitter_url": next((m.twitter_url for m in metrics if m.twitter_url), None),
        "telegram_url": next((m.telegram_url for m in metrics if m.telegram_url), None),
        "discord_url": next((m.discord_url for m in metrics if m.discord_url), None),
        "website_url": next((m.website_url for m in metrics if m.website_url), None),
    }
    return {
        "token": {
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
            "latest_metric": {
                "id": metrics[0].id,
                "token_id": metrics[0].token_id,
                "timestamp": metrics[0].timestamp,
                "price_usd": metrics[0].price_usd,
                "ath_usd": metrics[0].ath_usd,
                "ath_date": metrics[0].ath_date,
                "market_cap": metrics[0].market_cap,
                "fdv": metrics[0].fdv,
                "liquidity_usd": metrics[0].liquidity_usd,
                "volume_24h": metrics[0].volume_24h,
                "tx_count_24h": metrics[0].tx_count_24h,
                "holder_count": metrics[0].holder_count,
                "twitter_url": metrics[0].twitter_url,
                "telegram_url": metrics[0].telegram_url,
                "discord_url": metrics[0].discord_url,
                "website_url": metrics[0].website_url,
                "social_engagements": metrics[0].social_engagements,
            } if metrics else None,
        },
        "metrics": [
            {
                "id": metric.id,
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
            for metric in metrics
        ],
        "top_wallets": top_wallets,
        "price_history": history,
        "social_links": social_links,
    }


async def get_wallet_activity(session: AsyncSession, wallet_address: str) -> dict[str, Any]:
    wallet_result = await session.execute(select(Wallet).where(Wallet.wallet_address == wallet_address))
    wallet = wallet_result.scalar_one_or_none()
    if wallet is None:
        raise ValueError("Wallet not found")

    trades_result = await session.execute(
        select(WalletTrade).where(WalletTrade.wallet_id == wallet.id).order_by(WalletTrade.buy_timestamp.desc())
    )
    trades = list(trades_result.scalars().all())
    profit_total = sum((trade.realized_profit_usd or 0) for trade in trades)
    token_count = len({trade.token_id for trade in trades})
    return {
        "wallet": wallet,
        "trades": trades,
        "profit_total": profit_total,
        "token_count": token_count,
    }


async def get_top_wallets(session: AsyncSession, limit: int, offset: int) -> tuple[list[dict[str, Any]], int]:
    total = await session.scalar(select(func.count()).select_from(Wallet)) or 0
    rows = await session.execute(
        select(
            Wallet.wallet_address,
            func.sum(func.coalesce(WalletTrade.realized_profit_usd, 0)).label("profit_total"),
            func.count(WalletTrade.id).label("trade_count"),
            func.count(func.distinct(WalletTrade.token_id)).label("token_count"),
        )
        .join(WalletTrade, Wallet.id == WalletTrade.wallet_id, isouter=True)
        .group_by(Wallet.id)
        .order_by(text("profit_total DESC"))
        .offset(offset)
        .limit(limit)
    )
    return [dict(row._mapping) for row in rows.all()], int(total)


async def get_insider_clusters(session: AsyncSession) -> list[dict[str, Any]]:
    rows = await session.execute(
        select(
            WalletLink.wallet_a_id,
            WalletLink.wallet_b_id,
            WalletLink.shared_tokens_count,
            WalletLink.first_interaction_date,
            WalletLink.similarity_score,
            WalletLink.details,
        )
        .where(WalletLink.shared_tokens_count >= 3)
        .order_by(WalletLink.similarity_score.desc())
    )
    return [dict(row._mapping) for row in rows.all()]


async def list_jobs(session: AsyncSession) -> list[CollectorJob]:
    result = await session.execute(select(CollectorJob).order_by(CollectorJob.updated_at.desc()))
    return list(result.scalars().all())


async def get_or_create_jobs(session: AsyncSession) -> None:
    for name in ("pumpfun_tokens", "token_metrics", "insider_clusters"):
        await ensure_job(session, name)
    await session.commit()


def _parse_datetime(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _to_float(value: Any) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _to_int(value: Any) -> int | None:
    try:
        return None if value is None else int(float(value))
    except (TypeError, ValueError):
        return None


def _extract_number(payload: dict[str, Any], keys: list[str]) -> Any:
    for key in keys:
        if key in payload:
            return payload[key]
        nested = payload.get("data") if isinstance(payload.get("data"), dict) else None
        if nested and key in nested:
            return nested[key]
    return None
