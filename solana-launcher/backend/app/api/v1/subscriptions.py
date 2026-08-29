from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.db.session import get_db
from app.models.subscription_order import SubscriptionOrder
from app.models.user import User
from app.schemas.subscription import (
    SubscriptionOrderComplete,
    SubscriptionOrderCreate,
    SubscriptionOrderRead,
    SubscriptionSettingsRead,
)
from app.services.subscriptions import (
    SubscriptionConflictError,
    SubscriptionPasswordError,
    complete_subscription_order,
    create_subscription_order,
    decrypt_order_password,
    get_subscription_order,
    get_subscription_settings,
)

router = APIRouter()


def _require_internal_access(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    api_key = request.headers.get("X-API-Key", "")
    expected_key = settings.backend_api_key
    is_dev_internal = (
        settings.environment == "development"
        and not expected_key
        and request.headers.get("X-Dev-Internal") == "miniapp-subscription"
    )
    if is_dev_internal:
        return settings
    if not expected_key or not hmac.compare_digest(api_key.encode(), expected_key.encode()):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid API key")
    return settings


def _password_encryption_key(settings: Settings) -> str:
    return settings.subscription_password_encryption_key.strip() or settings.secret_key


async def _subscription_expiry(session: AsyncSession, order: SubscriptionOrder):
    if order.status != "paid":
        return None
    result = await session.execute(
        select(User.subscription_expires_at).where(User.telegram_id == str(order.telegram_user_id))
    )
    return result.scalar_one_or_none()


async def _as_response(
    session: AsyncSession,
    order: SubscriptionOrder,
    *,
    settings: Settings,
    already_paid: bool = False,
    password: str | None = None,
) -> SubscriptionOrderRead:
    if password is None and order.status == "paid":
        password = decrypt_order_password(
            order.password_ciphertext,
            _password_encryption_key(settings),
            legacy_encryption_key=settings.secret_key,
        )
    return SubscriptionOrderRead(
        payload=order.payload,
        telegram_user_id=order.telegram_user_id,
        username=order.username,
        login=order.login,
        currency=order.currency,
        total_amount=order.total_amount,
        access_days=order.access_days,
        status=order.status,
        password=password,
        recipient_wallet=order.recipient_wallet,
        payment_reference=order.payment_reference,
        payment_url=order.payment_url,
        payment_signature=order.payment_signature,
        created_at=order.created_at,
        updated_at=order.updated_at,
        paid_at=order.paid_at,
        subscription_expires_at=await _subscription_expiry(session, order),
        already_paid=already_paid,
    )


@router.get("/settings", response_model=SubscriptionSettingsRead)
async def read_settings(
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> SubscriptionSettingsRead:
    _require_internal_access(request)
    settings = await get_subscription_settings(session)
    return SubscriptionSettingsRead(
        monthly_price_sol=settings.monthly_price_sol,
        monthly_price_usdt=settings.monthly_price_usdt,
        free_demo_enabled=settings.free_demo_enabled,
        demo_days=settings.demo_days,
        solana_recipient_wallet=settings.solana_recipient_wallet,
    )


@router.post("/orders", response_model=SubscriptionOrderRead, status_code=status.HTTP_201_CREATED)
async def create_order(
    request: Request,
    payload: SubscriptionOrderCreate,
    session: AsyncSession = Depends(get_db),
) -> SubscriptionOrderRead:
    settings = _require_internal_access(request)
    try:
        order = await create_subscription_order(session, payload)
    except SubscriptionConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return await _as_response(session, order, settings=settings)


@router.get("/orders/{payload}", response_model=SubscriptionOrderRead)
async def read_order(
    payload: str,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> SubscriptionOrderRead:
    settings = _require_internal_access(request)
    order = await get_subscription_order(session, payload)
    if order is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Subscription order not found",
        )
    try:
        return await _as_response(session, order, settings=settings)
    except SubscriptionPasswordError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc


@router.post("/orders/{payload}/complete", response_model=SubscriptionOrderRead)
async def complete_order(
    payload: str,
    body: SubscriptionOrderComplete,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> SubscriptionOrderRead:
    settings = _require_internal_access(request)
    try:
        order, password, _expires_at, already_paid = await complete_subscription_order(
            session,
            payload,
            body,
            encryption_key=_password_encryption_key(settings),
            legacy_encryption_key=settings.secret_key,
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except SubscriptionConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except SubscriptionPasswordError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc
    return await _as_response(
        session,
        order,
        settings=settings,
        already_paid=already_paid,
        password=password,
    )
