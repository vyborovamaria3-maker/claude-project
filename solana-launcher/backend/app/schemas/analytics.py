from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field


class TokenStatus(StrEnum):
    ACTIVE = "active"
    MIGRATED = "migrated"
    RUGGED = "rugged"


class TokenBase(BaseModel):
    mint_address: str
    name: str | None = None
    symbol: str | None = None
    description: str | None = None
    creator_wallet: str | None = None
    creation_date: datetime | None = None
    migrated_to_raydium: bool = False
    migration_date: datetime | None = None
    status: TokenStatus = TokenStatus.ACTIVE


class TokenRead(TokenBase):
    id: int
    last_synced_at: datetime

    model_config = ConfigDict(from_attributes=True)


class TokenMetricRead(BaseModel):
    id: int
    token_id: int
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
    social_engagements: dict | None = None

    model_config = ConfigDict(from_attributes=True)


class TokenListItem(TokenRead):
    latest_metric: TokenMetricRead | None = None


class WalletRead(BaseModel):
    id: int
    wallet_address: str
    first_seen_date: datetime | None = None
    tags: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class WalletTradeRead(BaseModel):
    id: int
    wallet_id: int
    token_id: int
    buy_timestamp: datetime
    sell_timestamp: datetime | None = None
    amount_buy: float
    amount_sold: float
    avg_buy_price: float | None = None
    avg_sell_price: float | None = None
    realized_profit_usd: float | None = None
    still_holding: bool
    extra: dict | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class WalletLinkRead(BaseModel):
    id: int
    wallet_a_id: int
    wallet_b_id: int
    shared_tokens_count: int
    first_interaction_date: datetime | None = None
    similarity_score: float
    details: dict | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class CollectorJobRead(BaseModel):
    id: int
    job_name: str
    last_run: datetime | None = None
    status: str
    meta: dict | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class PagingMeta(BaseModel):
    limit: int
    offset: int
    total: int


class TokenListResponse(BaseModel):
    items: list[TokenListItem]
    meta: PagingMeta


class TokenAnalysisResponse(BaseModel):
    token: TokenListItem
    metrics: list[TokenMetricRead]
    top_wallets: list[dict]
    price_history: list[dict]
    social_links: dict


class WalletActivityResponse(BaseModel):
    wallet: WalletRead
    trades: list[WalletTradeRead]
    profit_total: float
    token_count: int


class WalletTopResponse(BaseModel):
    items: list[dict]
    meta: PagingMeta


class InsiderClusterResponse(BaseModel):
    items: list[dict]


class CollectorRunResponse(BaseModel):
    detail: str
    tasks: list[str]


class JobStatusResponse(BaseModel):
    jobs: list[CollectorJobRead]
