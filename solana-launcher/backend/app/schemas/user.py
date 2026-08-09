from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class UserBase(BaseModel):
    email: EmailStr | None = None
    full_name: str | None = None
    wallet_address: str | None = None
    telegram_id: str | None = None
    telegram_username: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    photo_url: str | None = None
    telegram_language_code: str | None = None
    telegram_is_premium: bool | None = None
    telegram_added_to_attachment_menu: bool | None = None
    telegram_allows_write_to_pm: bool | None = None
    telegram_profile: dict | None = None


class UserCreate(UserBase):
    email: EmailStr
    password: str = Field(min_length=8)


class UserRead(UserBase):
    id: UUID
    is_active: bool
    is_superuser: bool
    nonce: int | None = None
    nonce_expires_at: datetime | None = None
    last_login_at: datetime | None = None
    last_ip: str | None = None
    ip_addresses: list[str] | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
