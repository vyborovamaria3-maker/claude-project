from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qsl
from uuid import UUID

import base58
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.security import create_access_token
from app.models.auth_log import AuthLog
from app.models.user import User


@dataclass(slots=True)
class LoginResult:
    user: User
    access_token: str
    expires_in: int


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _ensure_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def has_active_site_access(user: User, *, now: datetime | None = None) -> bool:
    if user.is_superuser:
        return True
    if not user.is_active or user.subscription_expires_at is None:
        return False
    current = now or _utcnow()
    return _ensure_utc(user.subscription_expires_at) > current


def require_active_site_access(user: User, *, now: datetime | None = None) -> None:
    if not has_active_site_access(user, now=now):
        raise PermissionError("Active subscription required")


def apply_telegram_profile(
    user: User,
    profile: dict[str, Any],
    *,
    fallback_username: str | None = None,
) -> None:
    def text(key: str, max_length: int = 255) -> str | None:
        value = profile.get(key)
        if not isinstance(value, str):
            return None
        value = value.strip()
        return value[:max_length] if value else None

    def boolean(key: str) -> bool | None:
        value = profile.get(key)
        return value if isinstance(value, bool) else None

    profile_id = profile.get("id")
    if not isinstance(profile_id, int) or isinstance(profile_id, bool) or profile_id <= 0:
        raise ValueError("Telegram profile id is invalid")
    if user.telegram_id and user.telegram_id != str(profile_id):
        raise ValueError("Telegram profile does not belong to this user")

    user.telegram_id = str(profile_id)
    user.telegram_username = text("username") or fallback_username
    user.first_name = text("first_name")
    user.last_name = text("last_name")
    user.photo_url = text("photo_url", 4096)
    user.telegram_language_code = text("language_code", 32)
    user.telegram_is_premium = boolean("is_premium")
    user.telegram_added_to_attachment_menu = boolean("added_to_attachment_menu")
    user.telegram_allows_write_to_pm = boolean("allows_write_to_pm")
    user.telegram_profile = dict(profile)

    display_name = " ".join(part for part in (user.first_name, user.last_name) if part)
    if display_name:
        user.full_name = display_name[:255]


def generate_nonce() -> int:
    return secrets.randbelow(90_000_000) + 10_000_000


def build_phantom_message(*, app_name: str, wallet_address: str, nonce: int, expires_at: datetime) -> str:
    expires_text = _ensure_utc(expires_at).isoformat()
    return (
        f"{app_name} wants you to sign in with your Solana wallet.\n\n"
        f"Wallet: {wallet_address}\n"
        f"Nonce: {nonce}\n"
        f"Expires At: {expires_text}\n\n"
        "This request will not trigger a blockchain transaction or cost any gas fees."
    )


def normalize_signature(signature: str) -> bytes:
    try:
        return base58.b58decode(signature)
    except Exception:
        try:
            return base64.b64decode(signature, validate=True)
        except Exception as exc:
            raise ValueError("Invalid signature encoding") from exc


def verify_phantom_signature(*, public_key: str, message: str, signature: str) -> bool:
    public_key_bytes = base58.b58decode(public_key)
    if len(public_key_bytes) != 32:
        raise ValueError("Invalid wallet address")
    verify_key = VerifyKey(public_key_bytes)
    signature_bytes = normalize_signature(signature)
    if len(signature_bytes) != 64:
        raise ValueError("Invalid signature length")
    try:
        verify_key.verify(message.encode("utf-8"), signature_bytes)
        return True
    except BadSignatureError as exc:
        raise ValueError("Invalid signature") from exc


def build_telegram_secret(bot_token: str) -> bytes:
    return hmac.new(key=b"WebAppData", msg=bot_token.encode("utf-8"), digestmod=hashlib.sha256).digest()


def parse_telegram_init_data(init_data: str) -> dict[str, str]:
    items = dict(parse_qsl(init_data, keep_blank_values=True))
    if not items:
        raise ValueError("init_data is empty")
    return items


def verify_telegram_init_data(
    *,
    init_data: str,
    bot_token: str,
    max_age_hours: int,
) -> tuple[dict[str, Any], dict[str, str]]:
    if not bot_token:
        raise ValueError("Telegram bot token is not configured")
    items = parse_telegram_init_data(init_data)
    received_hash = items.pop("hash", None)
    if not received_hash or len(received_hash) != 64:
        raise ValueError("Missing or invalid hash")

    auth_date_raw = items.get("auth_date")
    if auth_date_raw is None:
        raise ValueError("Missing auth_date")
    try:
        auth_date = datetime.fromtimestamp(int(auth_date_raw), tz=timezone.utc)
    except (TypeError, ValueError, OSError) as exc:
        raise ValueError("Invalid auth_date") from exc

    now = _utcnow()
    if auth_date < now - timedelta(hours=max_age_hours):
        raise ValueError("init_data is too old")
    if auth_date > now + timedelta(minutes=5):
        raise ValueError("init_data timestamp is in the future")

    data_check_string = "\n".join(f"{key}={value}" for key, value in sorted(items.items()))
    secret = build_telegram_secret(bot_token)
    calculated_hash = hmac.new(secret, data_check_string.encode("utf-8"), digestmod=hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calculated_hash, received_hash):
        raise ValueError("Invalid Telegram hash")

    user_raw = items.get("user")
    if not user_raw:
        raise ValueError("Missing user")
    try:
        user_data = json.loads(user_raw)
    except json.JSONDecodeError as exc:
        raise ValueError("Invalid Telegram user data") from exc
    if not isinstance(user_data, dict):
        raise ValueError("Invalid Telegram user data")
    user_id = user_data.get("id")
    if not isinstance(user_id, int) or isinstance(user_id, bool) or user_id <= 0:
        raise ValueError("Invalid Telegram user id")
    return user_data, items


async def get_user_by_wallet(session: AsyncSession, wallet_address: str) -> User | None:
    result = await session.execute(select(User).where(User.wallet_address == wallet_address))
    return result.scalar_one_or_none()


async def get_user_by_telegram_id(session: AsyncSession, telegram_id: str) -> User | None:
    result = await session.execute(select(User).where(User.telegram_id == telegram_id))
    return result.scalar_one_or_none()


async def get_user_by_email(session: AsyncSession, email: str) -> User | None:
    result = await session.execute(select(User).where(User.email == email))
    return result.scalar_one_or_none()


async def get_user_by_id(session: AsyncSession, user_id: UUID | str) -> User | None:
    return await session.get(User, str(user_id))


async def create_auth_log(
    session: AsyncSession,
    *,
    event_type: str,
    provider: str,
    success: bool,
    user_id: str | None = None,
    wallet_address: str | None = None,
    telegram_id: str | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
    metadata: dict[str, Any] | None = None,
    error_message: str | None = None,
    commit: bool = True,
) -> AuthLog:
    log = AuthLog(
        user_id=user_id,
        event_type=event_type,
        provider=provider,
        success=success,
        wallet_address=wallet_address,
        telegram_id=telegram_id,
        ip_address=ip_address,
        user_agent=user_agent,
        meta=metadata,
        error_message=error_message,
    )
    session.add(log)
    if commit:
        await session.commit()
    return log


async def create_or_update_email_user(
    session: AsyncSession,
    *,
    email: str,
    full_name: str | None,
    password: str,
) -> User:
    existing_user = await get_user_by_email(session, email)
    if existing_user is not None:
        raise ValueError("User with this email already exists")

    from app.core.security import get_password_hash

    user = User(email=email, full_name=full_name, hashed_password=get_password_hash(password), is_active=True)
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user


async def authenticate_user(session: AsyncSession, email: str, password: str) -> User | None:
    from app.core.security import verify_password

    user = await get_user_by_email(session, email)
    if user is None or not user.hashed_password or not verify_password(password, user.hashed_password):
        return None
    return user


async def ensure_admin_user(sessionmaker, settings) -> User:
    from app.core.security import get_password_hash

    async with sessionmaker() as session:
        existing_user = await get_user_by_email(session, settings.admin_username)
        if existing_user is not None:
            return existing_user

        user = User(
            email=settings.admin_username,
            full_name=settings.admin_display_name,
            hashed_password=get_password_hash(settings.admin_password),
            is_active=True,
            is_superuser=True,
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        return user


async def sync_login_metadata(
    session: AsyncSession,
    user: User,
    *,
    ip_address: str | None,
    source: str,
    user_agent: str | None = None,
) -> User:
    now = _utcnow()
    ips = list(user.ip_addresses or [])
    if ip_address and ip_address not in ips:
        ips.append(ip_address)
    user.last_ip = ip_address
    user.last_login_at = now
    user.ip_addresses = ips[-100:]
    session.add(user)
    await create_auth_log(
        session,
        event_type=f"{source}_login",
        provider=source,
        success=True,
        user_id=user.id,
        wallet_address=user.wallet_address,
        telegram_id=user.telegram_id,
        ip_address=ip_address,
        user_agent=(user_agent or "")[:512] or None,
        metadata={"action": "login"},
        commit=False,
    )
    await session.commit()
    return user


def can_merge_accounts(source: User, target: User) -> bool:
    source_identity_count = sum(
        1
        for value in (
            source.email,
            source.access_login,
            source.wallet_address,
            source.telegram_id,
            source.hashed_password,
        )
        if value
    )
    target_identity_count = sum(
        1
        for value in (
            target.email,
            target.access_login,
            target.wallet_address,
            target.telegram_id,
            target.hashed_password,
        )
        if value
    )
    return source_identity_count <= 1 and target_identity_count >= 1


def merge_user_records(target: User, source: User) -> User:
    for field in (
        "email",
        "access_login",
        "full_name",
        "hashed_password",
        "wallet_address",
        "telegram_id",
        "telegram_username",
        "first_name",
        "last_name",
        "photo_url",
        "telegram_language_code",
        "telegram_is_premium",
        "telegram_added_to_attachment_menu",
        "telegram_allows_write_to_pm",
        "telegram_profile",
    ):
        target_value = getattr(target, field)
        source_value = getattr(source, field)
        if target_value is None and source_value is not None:
            setattr(target, field, source_value)
        elif target_value is not None and source_value is not None and target_value != source_value:
            raise ValueError(f"Conflicting {field}")

    if source.subscription_expires_at:
        source_expiry = _ensure_utc(source.subscription_expires_at)
        target_expiry = _ensure_utc(target.subscription_expires_at) if target.subscription_expires_at else None
        if target_expiry is None or source_expiry > target_expiry:
            target.subscription_expires_at = source.subscription_expires_at

    if source.ip_addresses:
        merged_ips = list(target.ip_addresses or [])
        for ip in source.ip_addresses:
            if ip not in merged_ips:
                merged_ips.append(ip)
        target.ip_addresses = merged_ips[-100:]
    if target.last_login_at is None:
        target.last_login_at = source.last_login_at
    if target.last_ip is None:
        target.last_ip = source.last_ip
    return target


async def issue_token_for_user(session: AsyncSession, user: User, settings: Settings) -> LoginResult:
    del session  # kept in the signature for backwards compatibility with callers
    now = _utcnow()
    require_active_site_access(user, now=now)

    configured = timedelta(minutes=settings.access_token_expire_minutes)
    if user.is_superuser:
        expires = configured
    else:
        subscription_remaining = _ensure_utc(user.subscription_expires_at) - now
        expires = min(configured, subscription_remaining)
        if expires.total_seconds() <= 0:
            raise PermissionError("Active subscription required")

    token = create_access_token(subject=str(user.id), settings=settings, expires_delta=expires)
    return LoginResult(user=user, access_token=token, expires_in=max(1, int(expires.total_seconds())))
