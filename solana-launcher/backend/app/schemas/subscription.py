from datetime import datetime

from pydantic import BaseModel, Field, field_validator


class SubscriptionOrderCreate(BaseModel):
    payload: str = Field(min_length=16, max_length=128)
    telegram_user_id: int = Field(ge=1)
    username: str | None = Field(default=None, max_length=255)
    login: str = Field(min_length=4, max_length=32)
    amount_usd: int = Field(gt=0, le=1_000_000)

    @field_validator("login")
    @classmethod
    def validate_login(cls, value: str) -> str:
        normalized = value.strip()
        if not all(char.isalnum() or char == "_" for char in normalized):
            raise ValueError("login must only contain letters, digits, or underscore")
        return normalized


class SubscriptionInvoiceUpdate(BaseModel):
    invoice_link: str = Field(min_length=1, max_length=2048)


class SubscriptionOrderComplete(BaseModel):
    password: str = Field(min_length=32, max_length=32)
    provider_charge_id: str | None = Field(default=None, max_length=255)
    telegram_payment_charge_id: str | None = Field(default=None, max_length=255)


class SubscriptionOrderRead(BaseModel):
    payload: str
    telegram_user_id: int
    username: str | None
    login: str
    amount_usd: int
    status: str
    password: str | None = None
    invoice_link: str | None
    provider_charge_id: str | None
    telegram_payment_charge_id: str | None
    created_at: datetime
    updated_at: datetime
    paid_at: datetime | None
    subscription_expires_at: datetime | None = None
    already_paid: bool = False
