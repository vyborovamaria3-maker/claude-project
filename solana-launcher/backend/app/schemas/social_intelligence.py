from __future__ import annotations

from pydantic import BaseModel, Field


class TelegramScanRequest(BaseModel):
    seeds: list[str] = Field(min_length=1, max_length=50)
    max_depth: int = Field(default=1, ge=0, le=3)
    post_limit: int = Field(default=200, ge=1, le=5000)
    entity_limit: int = Field(default=100, ge=1, le=1000)


class TelegramMonitorRequest(BaseModel):
    channels: list[str] = Field(min_length=1, max_length=200)


class TelegramAttachSessionRequest(BaseModel):
    session_string: str = Field(min_length=20, max_length=16384)


class XTweetIngest(BaseModel):
    id: str
    text: str = ""
    author_handle: str | None = None
    author_display_name: str | None = None
    url: str | None = None
    views: int = 0
    likes: int = 0
    retweets: int = 0
    replies: int = 0
    is_verified: bool = False
    posted_at: int | float | None = None
    suspicion_score: float | None = None


class XSocialIngestRequest(BaseModel):
    token_mint: str | None = None
    token_symbol: str | None = None
    token_twitter_handle: str | None = None
    strategy: str | None = None
    tweets: list[XTweetIngest] = Field(default_factory=list, max_length=500)
