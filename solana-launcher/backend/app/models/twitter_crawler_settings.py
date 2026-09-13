from __future__ import annotations

import math
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, validates

from app.db.base import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class TwitterCrawlerSettings(Base):
    __tablename__ = "twitter_crawler_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    query_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=50)
    process_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=250)
    batch_size: Mapped[int] = mapped_column(Integer, nullable=False, default=25)
    max_depth: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    min_relevance: Mapped[float] = mapped_column(Float, nullable=False, default=35.0)
    network_mode: Mapped[str] = mapped_column(String(16), nullable=False, default="following")
    network_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    lease_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=300)
    rescore_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=1500)
    public_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    public_dexscreener_latest: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    public_dexscreener_boosts: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    public_db_solana_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=500)
    public_cmc_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    public_rescore_limit: Mapped[int] = mapped_column(Integer, nullable=False, default=3000)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )

    @validates("query_limit")
    def validate_query_limit(self, _key: str, value: int) -> int:
        return self._bounded_int(value, 10, 100, "query_limit")

    @validates("process_limit")
    def validate_process_limit(self, _key: str, value: int) -> int:
        return self._bounded_int(value, 1, 5000, "process_limit")

    @validates("batch_size")
    def validate_batch_size(self, _key: str, value: int) -> int:
        return self._bounded_int(value, 1, 250, "batch_size")

    @validates("max_depth")
    def validate_max_depth(self, _key: str, value: int) -> int:
        return self._bounded_int(value, 0, 8, "max_depth")

    @validates("network_limit")
    def validate_network_limit(self, _key: str, value: int) -> int:
        return self._bounded_int(value, 1, 1000, "network_limit")

    @validates("lease_seconds")
    def validate_lease_seconds(self, _key: str, value: int) -> int:
        return self._bounded_int(value, 30, 3600, "lease_seconds")

    @validates("rescore_limit")
    def validate_rescore_limit(self, _key: str, value: int) -> int:
        return self._bounded_int(value, 1, 5000, "rescore_limit")

    @validates("public_db_solana_tokens")
    def validate_public_db_solana_tokens(self, _key: str, value: int) -> int:
        return self._bounded_int(value, 0, 10000, "public_db_solana_tokens")

    @validates("public_cmc_limit")
    def validate_public_cmc_limit(self, _key: str, value: int) -> int:
        return self._bounded_int(value, 0, 5000, "public_cmc_limit")

    @validates("public_rescore_limit")
    def validate_public_rescore_limit(self, _key: str, value: int) -> int:
        return self._bounded_int(value, 0, 5000, "public_rescore_limit")

    @validates("min_relevance")
    def validate_min_relevance(self, _key: str, value: float) -> float:
        normalized = float(value)
        if not math.isfinite(normalized) or normalized < 0.0 or normalized > 100.0:
            raise ValueError("min_relevance must be a finite number between 0 and 100")
        return normalized

    @validates("network_mode")
    def validate_network_mode(self, _key: str, value: str) -> str:
        if not isinstance(value, str):
            raise ValueError("network_mode must be none, following, followers, or both")
        normalized = value.strip().lower()
        if normalized not in {"none", "following", "followers", "both"}:
            raise ValueError("network_mode must be none, following, followers, or both")
        return normalized

    @staticmethod
    def _bounded_int(value: int, minimum: int, maximum: int, field: str) -> int:
        normalized = int(value)
        if normalized < minimum or normalized > maximum:
            raise ValueError(f"{field} must be between {minimum} and {maximum}")
        return normalized
