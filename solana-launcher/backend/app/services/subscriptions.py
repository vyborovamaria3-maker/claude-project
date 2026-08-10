from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_password_hash, verify_password
from app.models.auth_log import AuthLog
from app.models.subscription_order import SubscriptionOrder
from app.models.subscription_settings import SubscriptionSettings
from app.models.user import User
from app.schemas.subscription import SubscriptionOrderComplete, SubscriptionOrderCreate
from app.services.auth import apply_telegram_profile


class SubscriptionConflictError(ValueError):
    pass


class SubscriptionPasswordError(RuntimeError):
    pass


PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
PASSWORD_LENGTH = 32
MAX_BASE_UNITS = 9_000_000_000_000_000


def generate_subscription_password() -> str:
    return "".join(
        secrets.choice(PASSWORD_ALPHABET) for _ in range(PASSWORD_LENGTH)
    )


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _active_expiry(user: User | None) -> datetime | None:
    if user is None:
        return None
    expiry = _as_utc(user.subscription_expires_at)
    if expiry is None or expiry <= datetime.now(UTC):
        return None
    return expiry


def _fernet(secret_key: str) -> Fernet:
    digest = hashlib.sha256(secret_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_order_password(password: str, secret_key: str) -> str:
    return _fernet(secret_key).encrypt(password.encode("utf-8")).decode("ascii")


def decrypt_order_password(
    ciphertext: str | None,
    secret_key: str,
) -> str | None:
    if not ciphertext:
        return None
    try:
        return _fernet(secret_key).decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError) as exc:
        raise SubscriptionPasswordError(
            "Unable to decrypt subscription password"
        ) from exc


async def _lock_subscription_user(
    session: AsyncSession,
    telegram_user_id: int,
) -> None:
    """Serialize checkout creation for one Telegram user on PostgreSQL."""
    bind = session.get_bind()
    if bind.dialect.name == "postgresql":
        await session.execute(
            text("SELECT pg_advisory_xact_lock(:lock_key)"),
            {"lock_key": int(telegram_user_id)},
        )


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


def _price_to_base_units(value: Decimal, decimals: int) -> int:
    scaled = Decimal(value) * (Decimal(10) ** decimals)
    integral = scaled.to_integral_value()
    if scaled != integral:
        raise SubscriptionConflictError(
            "Configured subscription price has unsupported precision"
        )
    amount = int(integral)
    if amount <= 0 or amount > MAX_BASE_UNITS:
        raise SubscriptionConflictError(
            "Configured subscription price is outside the supported range"
        )
    return amount


async def _validate_new_order_policy(
    session: AsyncSession,
    payload: SubscriptionOrderCreate,
) -> SubscriptionSettings:
    """Treat PostgreSQL admin settings as the source of truth for new access."""
    settings = await get_subscription_settings(session)

    if payload.currency == "DEMO":
        if not settings.free_demo_enabled:
            raise SubscriptionConflictError("Free demo access is disabled")
        if payload.total_amount != 0:
            raise SubscriptionConflictError("Demo order must be free")
        if payload.access_days != settings.demo_days:
            raise SubscriptionConflictError(
                "Demo duration does not match current admin settings"
            )
        return settings

    if not settings.paid_subscriptions_enabled:
        raise SubscriptionConflictError("Paid subscriptions are disabled")
    if payload.access_days != 30:
        raise SubscriptionConflictError("Paid subscription must grant exactly 30 days")

    recipient = settings.solana_recipient_wallet.strip()
    if not recipient:
        raise SubscriptionConflictError("Recipient Solana wallet is not configured")
    if payload.recipient_wallet != recipient:
        raise SubscriptionConflictError(
            "Payment recipient does not match current admin settings"
        )

    if payload.currency == "SOL":
        expected_amount = _price_to_base_units(settings.monthly_price_sol, 9)
    else:
        expected_amount = _price_to_base_units(settings.monthly_price_usdt, 6)
    if payload.total_amount != expected_amount:
        raise SubscriptionConflictError(
            "Payment amount does not match current admin settings"
        )
    return settings


async def _login_owner(session: AsyncSession, login: str) -> User | None:
    result = await session.execute(
        select(User).where(User.access_login == login)
    )
    return result.scalar_one_or_none()


async def _telegram_user(
    session: AsyncSession,
    telegram_user_id: int,
) -> User | None:
    result = await session.execute(
        select(User)
        .where(User.telegram_id == str(telegram_user_id))
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _existing_demo_order(
    session: AsyncSession,
    telegram_user_id: int,
) -> SubscriptionOrder | None:
    result = await session.execute(
        select(SubscriptionOrder)
        .where(SubscriptionOrder.telegram_user_id == telegram_user_id)
        .where(SubscriptionOrder.currency == "DEMO")
        .order_by(SubscriptionOrder.created_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _has_paid_purchase(
    session: AsyncSession,
    telegram_user_id: int,
) -> bool:
    result = await session.execute(
        select(SubscriptionOrder.payload)
        .where(SubscriptionOrder.telegram_user_id == telegram_user_id)
        .where(SubscriptionOrder.currency.in_(("SOL", "USDT")))
        .where(SubscriptionOrder.status == "paid")
        .limit(1)
    )
    return result.scalar_one_or_none() is not None


async def _latest_paid_order(
    session: AsyncSession,
    telegram_user_id: int,
    *,
    login: str,
) -> SubscriptionOrder | None:
    result = await session.execute(
        select(SubscriptionOrder)
        .where(SubscriptionOrder.telegram_user_id == telegram_user_id)
        .where(SubscriptionOrder.login == login)
        .where(SubscriptionOrder.status == "paid")
        .where(SubscriptionOrder.password_ciphertext.isnot(None))
        .order_by(
            SubscriptionOrder.paid_at.desc(),
            SubscriptionOrder.created_at.desc(),
        )
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _recover_current_password(
    session: AsyncSession,
    user: User,
    *,
    secret_key: str,
) -> str | None:
    hashed_password = user.hashed_password
    telegram_id = user.telegram_id
    access_login = user.access_login
    if not telegram_id or not access_login or not hashed_password:
        return None

    result = await session.execute(
        select(SubscriptionOrder)
        .where(SubscriptionOrder.telegram_user_id == int(telegram_id))
        .where(SubscriptionOrder.login == access_login)
        .where(SubscriptionOrder.status == "paid")
        .where(SubscriptionOrder.password_ciphertext.isnot(None))
        .order_by(
            SubscriptionOrder.paid_at.desc(),
            SubscriptionOrder.created_at.desc(),
        )
    )
    for prior in result.scalars().all():
        try:
            candidate = decrypt_order_password(
                prior.password_ciphertext,
                secret_key,
            )
        except SubscriptionPasswordError:
            continue
        if candidate and verify_password(candidate, hashed_password):
            return candidate
    return None


def _validate_order_shape(payload: SubscriptionOrderCreate) -> None:
    if payload.currency == "DEMO":
        if payload.total_amount != 0:
            raise SubscriptionConflictError("Demo order must be free")
        if (
            payload.recipient_wallet
            or payload.payment_reference
            or payload.payment_url
        ):
            raise SubscriptionConflictError(
                "Demo order cannot contain payment details"
            )
        return

    if payload.total_amount <= 0:
        raise SubscriptionConflictError(
            "Paid subscription amount must be greater than zero"
        )
    if (
        not payload.recipient_wallet
        or not payload.payment_reference
        or not payload.payment_url
    ):
        raise SubscriptionConflictError("Solana payment details are required")


async def create_subscription_order(
    session: AsyncSession,
    payload: SubscriptionOrderCreate,
) -> SubscriptionOrder:
    _validate_order_shape(payload)
    await _lock_subscription_user(session, payload.telegram_user_id)

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
            raise SubscriptionConflictError(
                "Subscription payload already belongs to another order"
            )
        return existing

    user = await _telegram_user(session, payload.telegram_user_id)
    if (
        user is not None
        and user.access_login
        and user.access_login != payload.login
    ):
        raise SubscriptionConflictError(
            f"This Telegram account already uses the site login {user.access_login}"
        )

    if payload.currency == "DEMO":
        await _validate_new_order_policy(session, payload)
        demo_order = await _existing_demo_order(
            session,
            payload.telegram_user_id,
        )
        if demo_order is not None:
            if demo_order.login == payload.login and demo_order.status == "pending":
                demo_order.access_days = payload.access_days
                demo_order.username = payload.username
                demo_order.telegram_profile = payload.telegram_profile
                await session.commit()
                await session.refresh(demo_order)
                return demo_order
            if (
                demo_order.login == payload.login
                and demo_order.status == "paid"
                and _active_expiry(user) is not None
            ):
                return demo_order
            raise SubscriptionConflictError(
                "Free demo access has already been used"
            )
        if await _has_paid_purchase(session, payload.telegram_user_id):
            raise SubscriptionConflictError(
                "Free demo is unavailable after a paid subscription"
            )

    login_owner = await _login_owner(session, payload.login)
    if (
        login_owner is not None
        and login_owner.telegram_id != str(payload.telegram_user_id)
    ):
        raise SubscriptionConflictError("This login is already in use")

    own_pending_result = await session.execute(
        select(SubscriptionOrder)
        .where(SubscriptionOrder.telegram_user_id == payload.telegram_user_id)
        .where(SubscriptionOrder.status == "pending")
        .order_by(SubscriptionOrder.created_at.desc())
        .limit(1)
    )
    own_pending = own_pending_result.scalar_one_or_none()
    if own_pending is not None:
        same_login = own_pending.login == payload.login
        both_paid_methods = (
            own_pending.currency in {"SOL", "USDT"}
            and payload.currency in {"SOL", "USDT"}
        )
        same_kind = own_pending.currency == payload.currency or both_paid_methods
        if same_login and same_kind:
            # A direct Solana transfer request cannot be revoked safely. Reuse
            # the original payment order instead of orphaning a late payment.
            return own_pending
        raise SubscriptionConflictError(
            "Finish the existing activation before starting another one"
        )

    pending_result = await session.execute(
        select(SubscriptionOrder)
        .where(SubscriptionOrder.login == payload.login)
        .where(SubscriptionOrder.status == "pending")
        .order_by(SubscriptionOrder.created_at.desc())
        .limit(1)
    )
    pending_order = pending_result.scalar_one_or_none()
    if pending_order is not None:
        if pending_order.telegram_user_id != payload.telegram_user_id:
            raise SubscriptionConflictError(
                "This login is reserved by another pending order"
            )
        return pending_order

    # Existing direct-payment orders above remain valid even if the admin later
    # changes pricing. A brand-new order must match the current DB settings.
    if payload.currency != "DEMO":
        await _validate_new_order_policy(session, payload)

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
        raise SubscriptionConflictError(
            "Subscription order conflicts with existing data"
        ) from exc
    await session.refresh(order)
    return order


async def get_subscription_order(
    session: AsyncSession,
    payload: str,
) -> SubscriptionOrder | None:
    return await session.get(SubscriptionOrder, payload)


async def get_latest_subscription_access(
    session: AsyncSession,
    telegram_user_id: int,
    *,
    secret_key: str,
) -> tuple[SubscriptionOrder, str, datetime] | None:
    user = await _telegram_user(session, telegram_user_id)
    expires_at = _active_expiry(user)
    if user is None or expires_at is None or not user.access_login:
        return None

    order = await _latest_paid_order(
        session,
        telegram_user_id,
        login=user.access_login,
    )
    if order is None:
        return None

    password = await _recover_current_password(
        session,
        user,
        secret_key=secret_key,
    )
    if not password:
        raise SubscriptionPasswordError(
            "Active subscription has no recoverable password"
        )
    return order, password, expires_at


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

    user_result = await session.execute(
        select(User)
        .where(User.telegram_id == str(order.telegram_user_id))
        .with_for_update()
    )
    user = user_result.scalar_one_or_none()

    if order.status == "paid":
        if user is None or user.subscription_expires_at is None:
            raise SubscriptionPasswordError(
                "Paid subscription has no active user"
            )
        if user.access_login != order.login:
            raise SubscriptionPasswordError(
                "Paid order no longer matches the active site login"
            )
        password = await _recover_current_password(
            session,
            user,
            secret_key=secret_key,
        )
        if not password:
            raise SubscriptionPasswordError(
                "Paid subscription has no recoverable password"
            )
        expires_at = _as_utc(user.subscription_expires_at)
        if expires_at is None:
            raise SubscriptionPasswordError("Paid subscription has no expiry")
        return order, password, expires_at, True

    if order.status != "pending":
        raise SubscriptionConflictError("Subscription order is not payable")

    if order.currency == "DEMO":
        if completion.payment_signature:
            raise SubscriptionConflictError(
                "Demo activation cannot contain a payment signature"
            )
        settings = await get_subscription_settings(session)
        if not settings.free_demo_enabled:
            raise SubscriptionConflictError("Free demo access is disabled")
        order.access_days = settings.demo_days
        if await _has_paid_purchase(session, order.telegram_user_id):
            raise SubscriptionConflictError(
                "Free demo is unavailable after a paid subscription"
            )
    elif not completion.payment_signature:
        raise SubscriptionConflictError(
            "Verified Solana payment signature is required"
        )

    if completion.payment_signature:
        signature_result = await session.execute(
            select(SubscriptionOrder.payload)
            .where(
                SubscriptionOrder.payment_signature
                == completion.payment_signature
            )
            .where(SubscriptionOrder.payload != payload)
            .limit(1)
        )
        if signature_result.scalar_one_or_none() is not None:
            raise SubscriptionConflictError(
                "Solana payment signature is already linked to another order"
            )

    login_owner = await _login_owner(session, order.login)
    if (
        login_owner is not None
        and login_owner.telegram_id != str(order.telegram_user_id)
    ):
        raise SubscriptionConflictError("This login is already in use")

    now = datetime.now(UTC)
    if user is None:
        user = User(
            telegram_id=str(order.telegram_user_id),
            access_login=order.login,
            is_active=True,
        )
        session.add(user)
        await session.flush()
        current_expiry = None
        password = None
    else:
        current_expiry = _as_utc(user.subscription_expires_at)
        if user.access_login and user.access_login != order.login:
            raise SubscriptionConflictError(
                "This Telegram account already uses the site login "
                f"{user.access_login}"
            )
        user.access_login = order.login
        user.is_active = True
        password = await _recover_current_password(
            session,
            user,
            secret_key=secret_key,
        )

    if order.telegram_profile:
        apply_telegram_profile(
            user,
            dict(order.telegram_profile),
            fallback_username=order.username,
        )
    elif order.username:
        user.telegram_username = order.username

    if not password:
        password = generate_subscription_password()
        user.hashed_password = get_password_hash(password)
    elif (
        not user.hashed_password
        or not verify_password(password, user.hashed_password)
    ):
        user.hashed_password = get_password_hash(password)

    base_expiry = (
        current_expiry
        if current_expiry is not None and current_expiry > now
        else now
    )
    expires_at = base_expiry + timedelta(days=order.access_days)
    user.subscription_expires_at = expires_at

    order.status = "paid"
    order.password_ciphertext = encrypt_order_password(password, secret_key)
    order.payment_signature = completion.payment_signature
    order.paid_at = now

    session.add(user)
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
