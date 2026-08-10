from datetime import UTC, datetime

from sqlalchemy import BigInteger, DateTime, Index, Integer, JSON, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SubscriptionOrder(Base):
    __tablename__ = "subscription_orders"
    __table_args__ = (
        Index(
            "uq_subscription_orders_pending_login",
            "login",
            unique=True,
            postgresql_where=text("status = 'pending'"),
            sqlite_where=text("status = 'pending'"),
        ),
        Index(
            "uq_subscription_orders_pending_user",
            "telegram_user_id",
            unique=True,
            postgresql_where=text("status = 'pending'"),
            sqlite_where=text("status = 'pending'"),
        ),
        Index(
            "uq_subscription_orders_demo_user",
            "telegram_user_id",
            unique=True,
            postgresql_where=text("currency = 'DEMO'"),
            sqlite_where=text("currency = 'DEMO'"),
        ),
    )

    payload: Mapped[str] = mapped_column(String(128), primary_key=True)
    telegram_user_id: Mapped[int] = mapped_column(BigInteger, index=True, nullable=False)
    username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    telegram_profile: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    login: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    currency: Mapped[str] = mapped_column(String(8), nullable=False)
    total_amount: Mapped[int] = mapped_column(BigInteger, nullable=False)
    access_days: Mapped[int] = mapped_column(Integer, nullable=False, default=30)
    status: Mapped[str] = mapped_column(String(16), index=True, default="pending", nullable=False)
    password_ciphertext: Mapped[str | None] = mapped_column(Text, nullable=True)
    recipient_wallet: Mapped[str | None] = mapped_column(String(64), nullable=True)
    payment_reference: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    payment_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    payment_signature: Mapped[str | None] = mapped_column(String(128), unique=True, nullable=True)
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
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
