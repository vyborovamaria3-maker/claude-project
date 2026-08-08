from __future__ import annotations

import base64
import hashlib
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_password_hash
from app.models.subscription_order import SubscriptionOrder
from app.models.user import User
from app.schemas.subscription import SubscriptionOrderComplete, SubscriptionOrderCreate


class SubscriptionConflictError(ValueError):
    pass


class SubscriptionPasswordError(RuntimeError):
    pass


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


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


async def _login_owner(session: AsyncSession, login: str) -> User | None:
    result = await session.execute(select(User).where(User.email == login))
    return result.scalar_one_or_none()


async def create_subscription_order(
    session: AsyncSession,
    payload: SubscriptionOrderCreate,
) -> SubscriptionOrder:
    existing = await session.get(SubscriptionOrder, payload.payload)
    if existing is not None:
        same_order = (
            existing.telegram_user_id == payload.telegram_user_id
            and existing.login == payload.login
            and existing.amount_usd == payload.amount_usd
        )
        if not same_order:
            raise SubscriptionConflictError("Subscription payload already belongs to another order")
        return existing

    login_owner = await _login_owner(session, payload.login)
    if login_owner is not None and login_owner.telegram_id != str(payload.telegram_user_id):
        raise SubscriptionConflictError("This login is already in use")

    order = SubscriptionOrder(
        payload=payload.payload,
        telegram_user_id=payload.telegram_user_id,
        username=payload.username,
        login=payload.login,
        amount_usd=payload.amount_usd,
        status="pending",
    )
    session.add(order)
    await session.commit()
    await session.refresh(order)
    return order


async def get_subscription_order(session: AsyncSession, payload: str) -> SubscriptionOrder | None:
    return await session.get(SubscriptionOrder, payload)


async def update_subscription_invoice(
    session: AsyncSession,
    payload: str,
    invoice_link: str,
) -> SubscriptionOrder | None:
    order = await session.get(SubscriptionOrder, payload)
    if order is None:
        return None
    order.invoice_link = invoice_link
    await session.commit()
    await session.refresh(order)
    return order


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

    login_owner = await _login_owner(session, order.login)
    if login_owner is not None and login_owner.telegram_id != str(order.telegram_user_id):
        raise SubscriptionConflictError("This login is already in use")

    user_result = await session.execute(
        select(User).where(User.telegram_id == str(order.telegram_user_id)).with_for_update()
    )
    user = user_result.scalar_one_or_none()

    now = datetime.now(timezone.utc)
    if user is None:
        user = User(
            telegram_id=str(order.telegram_user_id),
            telegram_username=order.username,
            email=order.login,
            is_active=True,
        )
        session.add(user)
        current_expiry = None
    else:
        current_expiry = _as_utc(user.subscription_expires_at)
        user.telegram_username = order.username
        user.email = order.login
        user.is_active = True

    base_expiry = current_expiry if current_expiry and current_expiry > now else now
    expires_at = base_expiry + timedelta(days=30)
    user.hashed_password = get_password_hash(completion.password)
    user.subscription_expires_at = expires_at

    order.status = "paid"
    order.password_ciphertext = encrypt_order_password(completion.password, secret_key)
    order.provider_charge_id = completion.provider_charge_id
    order.telegram_payment_charge_id = completion.telegram_payment_charge_id
    order.paid_at = now

    await session.commit()
    await session.refresh(order)
    return order, completion.password, expires_at, False
