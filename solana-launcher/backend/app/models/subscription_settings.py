from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, validates

from app.db.base import Base


class SubscriptionSettings(Base):
    __tablename__ = "subscription_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    monthly_price_sol: Mapped[Decimal] = mapped_column(
        Numeric(20, 9),
        nullable=False,
        default=Decimal("0"),
    )
    monthly_price_usdt: Mapped[Decimal] = mapped_column(
        Numeric(20, 6),
        nullable=False,
        default=Decimal("0"),
    )
    free_demo_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    demo_days: Mapped[int] = mapped_column(Integer, nullable=False, default=30)
    solana_recipient_wallet: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        nullable=False,
    )

    @validates("monthly_price_sol", "monthly_price_usdt")
    def validate_price(self, _key: str, value: Decimal) -> Decimal:
        normalized = Decimal(value)
        if normalized < 0:
            raise ValueError("Subscription prices cannot be negative")
        return normalized

    @validates("demo_days")
    def validate_demo_days(self, _key: str, value: int) -> int:
        normalized = int(value)
        if normalized < 1 or normalized > 3650:
            raise ValueError("Demo days must be between 1 and 3650")
        return normalized

    @validates("solana_recipient_wallet")
    def validate_wallet(self, _key: str, value: str) -> str:
        return (value or "").strip()
