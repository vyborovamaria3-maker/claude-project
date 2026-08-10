from __future__ import annotations

from datetime import datetime
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, field_validator

BASE58_ALPHABET = frozenset("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")


def _normalize_wallet_address(value: str) -> str:
    normalized = value.strip()
    if len(normalized) < 32 or len(normalized) > 44:
        raise ValueError("wallet_address must be a valid Solana public key")
    if any(char not in BASE58_ALPHABET for char in normalized):
        raise ValueError("wallet_address must be base58 encoded")
    return normalized


def _normalize_signature(value: str) -> str:
    normalized = value.strip()
    if len(normalized) < 32 or len(normalized) > 128:
        raise ValueError("signature has an invalid length")
    if any(char.isspace() for char in normalized):
        raise ValueError("signature must not contain whitespace")
    return normalized


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)


class PhantomNonceRequest(BaseModel):
    wallet_address: str = Field(min_length=32, max_length=44)

    @field_validator("wallet_address")
    @classmethod
    def validate_wallet_address(cls, value: str) -> str:
        return _normalize_wallet_address(value)


class PhantomNonceResponse(BaseModel):
    nonce: int
    message: str
    expires_at: datetime


class PhantomVerifyRequest(BaseModel):
    wallet_address: str = Field(min_length=32, max_length=44)
    nonce: int = Field(ge=100000, le=99999999)
    signature: str = Field(min_length=32, max_length=128)

    @field_validator("wallet_address")
    @classmethod
    def validate_wallet_address(cls, value: str) -> str:
        return _normalize_wallet_address(value)

    @field_validator("signature")
    @classmethod
    def validate_signature(cls, value: str) -> str:
        return _normalize_signature(value)


class TelegramUserData(BaseModel):
    id: int
    username: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    photo_url: str | None = None


class TelegramVerifyRequest(BaseModel):
    init_data: str = Field(min_length=1)


class LinkRequest(BaseModel):
    wallet_address: str | None = Field(default=None, min_length=32, max_length=44)
    nonce: int | None = Field(default=None, ge=100000, le=99999999)
    signature: str | None = Field(default=None, min_length=32, max_length=128)
    init_data: str | None = None

    @field_validator("wallet_address")
    @classmethod
    def validate_wallet_address(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _normalize_wallet_address(value)

    @field_validator("signature")
    @classmethod
    def validate_signature(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _normalize_signature(value)

    @field_validator("signature")
    @classmethod
    def signature_requires_wallet(cls, value: str | None, info):
        if value is not None and info.data.get("wallet_address") is None:
            raise ValueError("wallet_address is required when signature is provided")
        return value


class AuthTokenData(BaseModel):
    sub: UUID
    jti: str
    exp: int
    iat: int


class TelegramCallbackRequest(BaseModel):
    init_data: str = Field(min_length=1)


class TelegramCallbackResponse(BaseModel):
    access_token: str
    expires_in: int
    redirect_url: str

    @field_validator("redirect_url")
    @classmethod
    def strip_redirect_credentials(cls, value: str) -> str:
        """Never serialize bearer credentials into browser-visible URL components."""
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("redirect_url must be an absolute HTTP(S) URL")
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", "", ""))


class RegisterPasswordRequest(BaseModel):
    telegram_id: int = Field(ge=1)
    login: str = Field(min_length=4, max_length=32)
    password: str = Field(min_length=32, max_length=32)
    telegram_username: str | None = Field(default=None, max_length=255)
    email: str | None = None

    @field_validator("login")
    @classmethod
    def validate_login(cls, value: str) -> str:
        normalized = value.strip()
        if len(normalized) < 4 or len(normalized) > 32:
            raise ValueError("login must be 4-32 characters")
        if not all(char.isalnum() or char == "_" for char in normalized):
            raise ValueError("login must only contain letters, digits, or underscore")
        return normalized


class LoginPasswordRequest(BaseModel):
    login: str = Field(min_length=4, max_length=32)
    password: str = Field(min_length=32, max_length=32)
