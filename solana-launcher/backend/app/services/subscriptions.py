from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_password_hash
from app.models.auth_log import AuthLog
from app.models.subscription_order import SubscriptionOrder
from app.models.subscription_settings import SubscriptionSettings
from app.models.user import User
from app.schemas.subscription import SubscriptionOrderComplete, SubscriptionOrderCreate


class SubscriptionConflictError(ValueError):
    pass


class SubscriptionPasswordError(RuntimeError):
    pass


PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
PASSWORD_LENGTH = 32


def generate_subscription_password() -> str:
    return "".join(secrets.choice(PASSWORD_ALPHABET) for _ in range(PASSWORD_LENGTH))


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _fernet(secret_key: str) -> Fernet:
    digest = hashlib.sha256(secret_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_order_password(password: str, secret_key: str) -> str:
    return _fernet(secret_key).encrypt(password.encode("utf-8")).decode("ascii")


def decrypt_order_password(ciphertext: str | None, secret_key: str) -> str | None:
    if not ciphertext:
        return None
    try:
        return _fernet(secret_key).decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError) as exc:
        raise SubscriptionPasswordError("Unable to decrypt subscription password") from exc


def _profile_text(profile: dict[str, Any], key: str, max_length: int = 255) -> str | None:
    value = profile.get(key)
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not normalized:
        return None
    return normalized[:max_length]


def _profile_bool(profile: dict[str, Any], key: str) -> bool | None:
    value = profile.get(key)
    return value if isinstance(value, bool) else None


def _apply_telegram_profile(user: User, order: SubscriptionOrder) -> None:
    profile = dict(order.telegram_profile or {})
    user.telegram_username = order.username or _profile_text(profile, "username")
    user.first_name = _profile_text(profile, "first_name")
    user.last_name = _profile_text(profile, "last_name")
    user.photo_url = _profile_text(profile, "photo_url", 4096)
    user.telegram_language_code = _profile_text(profile, "language_code", 32)
    user.telegram_is_premium = _profile_bool(profile, "is_premium")
    user.telegram_added_to_attachment_menu = _profile_bool(profile, "added_to_attachment_menu")
    user.telegram_allows_write_to_pm = _profile_bool(profile, "allows_write_to_pm")
    user.telegram_profile = profile or None

    display_name = " ".join(part for part in (user.first_name, user.last_name) if part)
    if display_name:
        user.full_name = display_name[:255]


async def get_subscription_settings(session: AsyncSession) -> SubscriptionSettings:
    settings = await session.get(SubscriptionSettings, 1)
    if settings is not None:
        return settings

    settings = SubscriptionSettings(id=1)
    session.add(settings)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        settings = await session.get(SubscriptionSettings, 1)
        if settings is None:
            raise
        return settings
    await session.refresh(settings)
    return settings


async def _login_owner(session: AsyncSession, login: str) -> User | None:
    result = await session.execute(select(User).where(User.email == login))
    return result.scalar_one_or_none()


async def _existing_demo_order(
    session: AsyncSession,
    telegram_user_id: int,
) -> SubscriptionOrder | None:
    result = await session.execute(
        select(SubscriptionOrder)
        .where(SubscriptionOrder.telegram_user_id == telegram_user_id)
        .where(SubscriptionOrder.currency == "DEMO")
        .limit(1)
    )
    return result.scalar_one_or_none()


def _validate_order_shape(payload: SubscriptionOrderCreate) -> None:
    if payload.telegram_profile is not None:
        profile_id = payload.telegram_profile.get("id")
        if not isinstance(profile_id, int) or profile_id != payload.telegram_user_id:
            raise SubscriptionConflictError("Telegram profile does not match Telegram user id")

    if payload.currency == "DEMO":
        if payload.total_amount != 0:
            raise SubscriptionConflictError("Demo order must be free")
        if payload.recipient_wallet or payload.payment_reference or payload.payment_url:
            raise SubscriptionConflictError("Demo order cannot contain payment details")
        return

    if payload.total_amount <= 0:
        raise SubscriptionConflictError("Paid subscription amount must be greater than zero")
    if not payload.recipient_wallet or not payload.payment_reference or not payload.payment_url:
        raise SubscriptionConflictError("Solana payment details are required")


async def create_subscription_order(
    session: AsyncSession,
    payload: SubscriptionOrderCreate,
) -> SubscriptionOrder:
    _validate_order_shape(payload)

    existing = await session.get(SubscriptionOrder, payload.payload)
    if existing is not None:
        same_order = (
            existing.telegram_user_id == payload.telegram_user_id
            and existing.login == payload.login
            and existing.currency == payload.currency
            and existing.total_amount == payload.total_amount
            and existing.access_days == payload.access_days
            and existing.recipient_wallet == payload.recipient_wallet
        )
        if not same_order:
            raise SubscriptionConflictError("Subscription payload already belongs to another order")
        return existing

    if payload.currency == "DEMO":
        demo_order = await _existing_demo_order(session, payload.telegram_user_id)
        if demo_order is not None:
            if demo_order.status == "pending" and demo_order.login == payload.login:
                return demo_order
            raise SubscriptionConflictError("Free demo access has already been used")

    login_owner = await _login_owner(session, payload.login)
    if login_owner is not None and login_owner.telegram_id != str(payload.telegram_user_id):
        raise SubscriptionConflictError("This login is already in use")

    pending_result = await session.execute(
        select(SubscriptionOrder)
        .where(SubscriptionOrder.login == payload.login)
        .where(SubscriptionOrder.status == "pending")
        .limit(1)
    )
    pending_order = pending_result.scalar_one_or_none()
    if pending_order is not None:
        if pending_order.telegram_user_id != payload.telegram_user_id:
            raise SubscriptionConflictError("This login is reserved by another pending order")
        same_checkout = (
            pending_order.currency == payload.currency
            and pending_order.total_amount == payload.total_amount
            and pending_order.access_days == payload.access_days
            and pending_order.recipient_wallet == payload.recipient_wallet
        )
        if same_checkout:
            return pending_order
        pending_order.status = "cancelled"
        await session.commit()

    order = SubscriptionOrder(
        payload=payload.payload,
        telegram_user_id=payload.telegram_user_id,
        username=payload.username,
        telegram_profile=payload.telegram_profile,
        login=payload.login,
        currency=payload.currency,
        total_amount=payload.total_amount,
        access_days=payload.access_days,
        recipient_wallet=payload.recipient_wallet,
        payment_reference=payload.payment_reference,
        payment_url=payload.payment_url,
        status="pending",
    )
    session.add(order)
    session.add(
        AuthLog(
            event_type="subscription_access_requested",
            provider="telegram_miniapp",
            success=True,
            telegram_id=str(payload.telegram_user_id),
            meta={
                "login": payload.login,
                "currency": payload.currency,
                "access_days": payload.access_days,
                "order_payload": payload.payload,
            },
        )
    )
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise SubscriptionConflictError("Subscription order conflicts with existing data") from exc
    await session.refresh(order)
    return order


async def get_subscription_order(session: AsyncSession, payload: str) -> SubscriptionOrder | None:
    return await session.get(SubscriptionOrder, payload)


async def complete_subscription_order(
    session: AsyncSession,
    payload: str,
    completion: SubscriptionOrderComplete,
    *,
    secret_key: str,
) -> tuple[SubscriptionOrder, str, datetime, bool]:
    result = await session.execute(
        select(SubscriptionOrder)
        .where(SubscriptionOrder.payload == payload)
        .with_for_update()
    )
    order = result.scalar_one_or_none()
    if order is None:
        raise LookupError("Subscription order not found")

    if order.status == "paid":
        password = decrypt_order_password(order.password_ciphertext, secret_key)
        if not password:
            raise SubscriptionPasswordError("Paid subscription has no recoverable password")
        user_result = await session.execute(
            select(User).where(User.telegram_id == str(order.telegram_user_id))
        )
        user = user_result.scalar_one_or_none()
        expires_at = _as_utc(user.subscription_expires_at) if user else None
        if expires_at is None:
            raise SubscriptionPasswordError("Paid subscription has no active user")
        return order, password, expires_at, True

    if order.status != "pending":
        raise SubscriptionConflictError("Subscription order is not payable")

    if order.currency == "DEMO":
        if completion.payment_signature:
            raise SubscriptionConflictError("Demo activation cannot contain a payment signature")
    elif not completion.payment_signature:
        raise SubscriptionConflictError("Verified Solana payment signature is required")

    if completion.payment_signature:
        signature_result = await session.execute(
            select(SubscriptionOrder.payload)
            .where(SubscriptionOrder.payment_signature == completion.payment_signature)
            .where(SubscriptionOrder.payload != payload)
            .limit(1)
        )
        if signature_result.scalar_one_or_none() is not None:
            raise SubscriptionConflictError(
                "Solana payment signature is already linked to another order"
            )

    login_owner = await _login_owner(session, order.login)
    if login_owner is not None and login_owner.telegram_id != str(order.telegram_user_id):
        raise SubscriptionConflictError("This login is already in use")

    user_result = await session.execute(
        select(User).where(User.telegram_id == str(order.telegram_user_id)).with_for_update()
    )
    user = user_result.scalar_one_or_none()

    now = datetime.now(UTC)
    if user is None:
        user = User(
            telegram_id=str(order.telegram_user_id),
            email=order.login,
            is_active=True,
        )
        session.add(user)
        current_expiry = None
    else:
        current_expiry = _as_utc(user.subscription_expires_at)
        user.email = order.login
        user.is_active = True

    _apply_telegram_profile(user, order)

    password = generate_subscription_password()
    base_expiry = current_expiry if current_expiry and current_expiry > now else now
    expires_at = base_expiry + timedelta(days=order.access_days)
    user.hashed_password = get_password_hash(password)
    user.subscription_expires_at = expires_at

    order.status = "paid"
    order.password_ciphertext = encrypt_order_password(password, secret_key)
    order.payment_signature = completion.payment_signature
    order.paid_at = now

    await session.flush()
    session.add(
        AuthLog(
            user_id=user.id,
            event_type="subscription_credentials_issued",
            provider="telegram_miniapp",
            success=True,
            telegram_id=str(order.telegram_user_id),
            meta={
                "login": order.login,
                "currency": order.currency,
                "access_days": order.access_days,
                "order_payload": order.payload,
            },
        )
    )

    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise SubscriptionConflictError(
            "Subscription payment conflicts with existing data"
        ) from exc
    await session.refresh(order)
    return order, password, expires_at, False
