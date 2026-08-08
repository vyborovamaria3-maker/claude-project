import re
from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator

LOGIN_RE = re.compile(r"^[A-Za-z0-9_]{4,32}$")


class SubscriptionSettingsRead(BaseModel):
    monthly_price_sol: Decimal
    monthly_price_usdt: Decimal
    free_demo_enabled: bool
    demo_days: int
    solana_recipient_wallet: str


class SubscriptionOrderCreate(BaseModel):
    payload: str = Field(min_length=16, max_length=128)
    telegram_user_id: int = Field(ge=1)
    username: str | None = Field(default=None, max_length=255)
    login: str = Field(min_length=4, max_length=32)
    currency: Literal["SOL", "USDT", "DEMO"]
    total_amount: int = Field(ge=0, le=9_000_000_000_000_000)
    access_days: int = Field(ge=1, le=3650)
    recipient_wallet: str | None = Field(default=None, max_length=64)
    payment_reference: str | None = Field(default=None, max_length=64)
    payment_url: str | None = Field(default=None, max_length=4096)

    @field_validator("login")
    @classmethod
    def validate_login(cls, value: str) -> str:
        normalized = value.strip()
        if not LOGIN_RE.fullmatch(normalized):
            raise ValueError("login must be 4-32 ASCII letters, digits, or underscore")
        return normalized


class SubscriptionOrderComplete(BaseModel):
    password: str = Field(min_length=32, max_length=32)
    payment_signature: str | None = Field(default=None, max_length=128)


class SubscriptionOrderRead(BaseModel):
    payload: str
    telegram_user_id: int
    username: str | None
    login: str
    currency: str
    total_amount: int
    access_days: int
    status: str
    password: str | None = None
    recipient_wallet: str | None
    payment_reference: str | None
    payment_url: str | None
    payment_signature: str | None
    created_at: datetime
    updated_at: datetime
    paid_at: datetime | None
    subscription_expires_at: datetime | None = None
    already_paid: bool = False
