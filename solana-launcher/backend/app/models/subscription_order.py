from datetime import datetime, timezone

from sqlalchemy import BigInteger, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SubscriptionOrder(Base):
    __tablename__ = "subscription_orders"

    payload: Mapped[str] = mapped_column(String(128), primary_key=True)
    telegram_user_id: Mapped[int] = mapped_column(BigInteger, index=True, nullable=False)
    username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    login: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    amount_usd: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(16), index=True, default="pending", nullable=False)
    password_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True)
    invoice_link: Mapped[str | None] = mapped_column(Text, nullable=True)
    provider_charge_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    telegram_payment_charge_id: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
