import hmac
import secrets
from datetime import timedelta, timezone, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.config import Settings
from app.core.rate_limit import RateLimitResult, make_limit_key
from app.db.session import get_db
from app.middleware.client_ip import get_client_ip
from app.schemas.auth import (
    LinkRequest,
    LoginPasswordRequest,
    LoginRequest,
    PhantomNonceRequest,
    PhantomNonceResponse,
    PhantomVerifyRequest,
    RegisterPasswordRequest,
    TelegramCallbackRequest,
    TelegramCallbackResponse,
    TelegramVerifyRequest,
)
from app.schemas.token import Token
from app.schemas.user import UserCreate, UserRead
from app.services.auth import (
    LoginResult,
    build_phantom_message,
    create_auth_log,
    generate_nonce,
    get_user_by_telegram_id,
    get_user_by_wallet,
    issue_token_for_user,
    merge_user_records,
    sync_login_metadata,
    verify_phantom_signature,
    verify_telegram_init_data,
)
from app.core.security import get_password_hash, verify_password
from app.services.users import authenticate_user, create_user

router = APIRouter()


async def _rate_limit(request: Request, *, key: str, limit: int, window_seconds: int) -> None:
    limiter = request.app.state.rate_limiter
    result: RateLimitResult = await limiter.allow(key, limit=limit, window_seconds=window_seconds)
    if not result.allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many requests",
            headers={"Retry-After": str(result.retry_after)},
        )


def _token_response(result: LoginResult) -> Token:
    return Token(access_token=result.access_token, expires_in=result.expires_in)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


@router.post("/register", response_model=UserRead, status_code=status.HTTP_201_CREATED)
async def register_user(user_in: UserCreate, session: AsyncSession = Depends(get_db)) -> UserRead:
    try:
        user = await create_user(session, user_in)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return UserRead.model_validate(user)


@router.post("/login", response_model=Token)
async def login(
    request: Request,
    form_data: OAuth2PasswordRequestForm = Depends(),
    session: AsyncSession = Depends(get_db),
) -> Token:
    settings: Settings = request.app.state.settings
    ip_address = get_client_ip(request)
    await _rate_limit(
        request,
        key=make_limit_key("login", "password", ip_address or "unknown"),
        limit=settings.auth_verify_rate_limit,
        window_seconds=settings.auth_rate_limit_window_seconds,
    )
    user = await authenticate_user(session, form_data.username, form_data.password)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect credentials")

    await sync_login_metadata(session, user, ip_address=ip_address, source="password")
    result = await issue_token_for_user(session, user, settings)
    return _token_response(result)


@router.post("/login-json", response_model=Token)
async def login_json(
    request: Request,
    login_in: LoginRequest,
    session: AsyncSession = Depends(get_db),
) -> Token:
    settings: Settings = request.app.state.settings
    ip_address = get_client_ip(request)
    await _rate_limit(
        request,
        key=make_limit_key("login", "json", ip_address or "unknown"),
        limit=settings.auth_verify_rate_limit,
        window_seconds=settings.auth_rate_limit_window_seconds,
    )
    user = await authenticate_user(session, login_in.email, login_in.password)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect credentials")

    await sync_login_metadata(session, user, ip_address=ip_address, source="password")
    result = await issue_token_for_user(session, user, settings)
    return _token_response(result)


@router.get("/me", response_model=UserRead)
async def me(current_user=Depends(get_current_user)) -> UserRead:
    return UserRead.model_validate(current_user)


@router.post("/phantom/nonce", response_model=PhantomNonceResponse)
async def phantom_nonce(
    request: Request,
    payload: PhantomNonceRequest,
    session: AsyncSession = Depends(get_db),
) -> PhantomNonceResponse:
    settings: Settings = request.app.state.settings
    ip_address = get_client_ip(request)
    await _rate_limit(
        request,
        key=make_limit_key("phantom", "nonce", ip_address or "unknown"),
        limit=settings.auth_nonce_rate_limit,
        window_seconds=settings.auth_rate_limit_window_seconds,
    )

    user = await get_user_by_wallet(session, payload.wallet_address)
    if user is None:
        from app.models.user import User

        user = User(wallet_address=payload.wallet_address, is_active=True)
        session.add(user)

    nonce = generate_nonce()
    expires_at = datetime.now(timezone.utc) + timedelta(
        minutes=settings.phantom_nonce_ttl_minutes
    )
    user.nonce = nonce
    user.nonce_expires_at = expires_at
    session.add(user)
    await session.commit()

    return PhantomNonceResponse(
        nonce=nonce,
        message=build_phantom_message(
            app_name=settings.app_name,
            wallet_address=payload.wallet_address,
            nonce=nonce,
            expires_at=expires_at,
        ),
        expires_at=expires_at,
    )


@router.post("/phantom/verify", response_model=Token)
async def phantom_verify(
    request: Request,
    payload: PhantomVerifyRequest,
    session: AsyncSession = Depends(get_db),
) -> Token:
    settings: Settings = request.app.state.settings
    ip_address = get_client_ip(request)
    await _rate_limit(
        request,
        key=make_limit_key("phantom", "verify", ip_address or "unknown"),
        limit=settings.auth_verify_rate_limit,
        window_seconds=settings.auth_rate_limit_window_seconds,
    )

    user = await get_user_by_wallet(session, payload.wallet_address)
    valid_nonce = (
        user is not None
        and user.nonce == payload.nonce
        and user.nonce_expires_at is not None
        and _as_utc(user.nonce_expires_at) >= datetime.now(timezone.utc)
    )
    try:
        if not valid_nonce:
            raise ValueError("Invalid nonce")
        message = build_phantom_message(
            app_name=settings.app_name,
            wallet_address=payload.wallet_address,
            nonce=payload.nonce,
            expires_at=user.nonce_expires_at,
        )
        verify_phantom_signature(
            public_key=payload.wallet_address,
            message=message,
            signature=payload.signature,
        )
    except ValueError:
        await create_auth_log(
            session,
            event_type="phantom_login",
            provider="phantom",
            success=False,
            user_id=user.id if user else None,
            wallet_address=payload.wallet_address,
            ip_address=ip_address,
            error_message="Invalid credentials",
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
        )

    user.nonce = None
    user.nonce_expires_at = None
    user = await sync_login_metadata(session, user, ip_address=ip_address, source="phantom")
    result = await issue_token_for_user(session, user, settings)
    return _token_response(result)


@router.post("/telegram/verify", response_model=Token)
async def telegram_verify(
    request: Request,
    payload: TelegramVerifyRequest,
    session: AsyncSession = Depends(get_db),
) -> Token:
    settings: Settings = request.app.state.settings
    ip_address = get_client_ip(request)
    await _rate_limit(
        request,
        key=make_limit_key("telegram", "verify", ip_address),
        limit=settings.auth_verify_rate_limit,
        window_seconds=settings.auth_rate_limit_window_seconds,
    )

    try:
        user_data, _ = verify_telegram_init_data(
            init_data=payload.init_data,
            bot_token=settings.telegram_bot_token,
            max_age_hours=settings.telegram_auth_max_age_hours,
        )
    except ValueError:
        await create_auth_log(
            session,
            event_type="telegram_verify",
            provider="telegram",
            success=False,
            ip_address=ip_address,
            error_message="Invalid Telegram init_data",
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    telegram_id = str(user_data["id"])
    user = await get_user_by_telegram_id(session, telegram_id)
    if user is None:
        from app.models.user import User

        user = User(
            telegram_id=telegram_id,
            telegram_username=user_data.get("username"),
            first_name=user_data.get("first_name"),
            last_name=user_data.get("last_name"),
            photo_url=user_data.get("photo_url"),
            is_active=True,
        )
        session.add(user)
        await session.flush()
    else:
        user.telegram_username = user_data.get("username")
        user.first_name = user_data.get("first_name")
        user.last_name = user_data.get("last_name")
        user.photo_url = user_data.get("photo_url")

    user = await sync_login_metadata(session, user, ip_address=ip_address, source="telegram")
    result = await issue_token_for_user(session, user, settings)
    return _token_response(result)


@router.post("/link", response_model=UserRead)
async def link_identity(
    request: Request,
    payload: LinkRequest,
    current_user=Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> UserRead:
    settings: Settings = request.app.state.settings
    ip_address = get_client_ip(request)

    if payload.wallet_address and payload.signature and payload.nonce is not None:
        await _rate_limit(
            request,
            key=make_limit_key("link", "wallet", ip_address, current_user.id, payload.wallet_address),
            limit=settings.auth_verify_rate_limit,
            window_seconds=settings.auth_rate_limit_window_seconds,
        )

        wallet_user = await get_user_by_wallet(session, payload.wallet_address)
        if wallet_user is None or wallet_user.nonce is None or wallet_user.nonce_expires_at is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

        if wallet_user.id != current_user.id:
            if not current_user.wallet_address:
                try:
                    current_user = merge_user_records(current_user, wallet_user)
                except ValueError:
                    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Wallet already linked")
                await session.delete(wallet_user)
            else:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Wallet already linked")

        wallet_message = build_phantom_message(
            app_name=settings.app_name,
            wallet_address=payload.wallet_address,
            nonce=wallet_user.nonce,
            expires_at=wallet_user.nonce_expires_at,
        )
        try:
            verify_phantom_signature(
                public_key=payload.wallet_address,
                message=wallet_message,
                signature=payload.signature,
            )
        except ValueError:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

        if wallet_user.nonce != payload.nonce or wallet_user.nonce_expires_at < datetime.now(timezone.utc):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

        current_user.wallet_address = payload.wallet_address
        current_user.nonce = None
        current_user.nonce_expires_at = None
        session.add(current_user)
        await session.flush()
        await session.commit()
        await session.refresh(current_user)
        await create_auth_log(
            session,
            event_type="link_wallet",
            provider="phantom",
            success=True,
            user_id=current_user.id,
            wallet_address=payload.wallet_address,
            ip_address=ip_address,
            metadata={"linked_to": "user"},
        )
        return UserRead.model_validate(current_user)

    if payload.init_data:
        try:
            user_data, _ = verify_telegram_init_data(
                init_data=payload.init_data,
                bot_token=settings.telegram_bot_token,
                max_age_hours=settings.telegram_auth_max_age_hours,
            )
        except ValueError:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

        telegram_id = str(user_data["id"])
        existing = await get_user_by_telegram_id(session, telegram_id)
        if existing is not None and existing.id != current_user.id:
            if not current_user.telegram_id:
                try:
                    current_user = merge_user_records(current_user, existing)
                except ValueError:
                    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Telegram account already linked")
                await session.delete(existing)
            else:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Telegram account already linked")

        current_user.telegram_id = telegram_id
        current_user.telegram_username = user_data.get("username")
        current_user.first_name = user_data.get("first_name")
        current_user.last_name = user_data.get("last_name")
        current_user.photo_url = user_data.get("photo_url")
        session.add(current_user)
        await session.flush()
        await session.commit()
        await session.refresh(current_user)
        await create_auth_log(
            session,
            event_type="link_telegram",
            provider="telegram",
            success=True,
            user_id=current_user.id,
            telegram_id=telegram_id,
            ip_address=ip_address,
            metadata={"linked_to": "user"},
        )
        return UserRead.model_validate(current_user)

    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Provide wallet signature or Telegram init_data")


@router.post("/telegram/callback", response_model=TelegramCallbackResponse)
async def telegram_callback(
    request: Request,
    payload: TelegramCallbackRequest,
    session: AsyncSession = Depends(get_db),
) -> TelegramCallbackResponse:
    settings: Settings = request.app.state.settings
    ip_address = get_client_ip(request)

    try:
        user_data, _ = verify_telegram_init_data(
            init_data=payload.init_data,
            bot_token=settings.telegram_bot_token,
            max_age_hours=settings.telegram_auth_max_age_hours,
        )
    except ValueError:
        await create_auth_log(
            session,
            event_type="telegram_callback",
            provider="telegram",
            success=False,
            ip_address=ip_address,
            error_message="Invalid Telegram init_data",
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    telegram_id = str(user_data["id"])

    user = await get_user_by_telegram_id(session, telegram_id)
    if user is None:
        from app.models.user import User

        user = User(
            telegram_id=telegram_id,
            telegram_username=user_data.get("username"),
            first_name=user_data.get("first_name"),
            last_name=user_data.get("last_name"),
            photo_url=user_data.get("photo_url"),
            is_active=True,
        )
        session.add(user)
        await session.flush()
    else:
        user.telegram_username = user_data.get("username")
        user.first_name = user_data.get("first_name")
        user.last_name = user_data.get("last_name")
        user.photo_url = user_data.get("photo_url")

    user = await sync_login_metadata(session, user, ip_address=ip_address, source="telegram")
    result = await issue_token_for_user(session, user, settings)

    # Bearer tokens stay in the response body and never enter browser-visible URLs.
    return TelegramCallbackResponse(
        access_token=result.access_token,
        expires_in=result.expires_in,
        redirect_url=settings.frontend_url,
    )


@router.post("/register-password")
async def register_password(
    request: Request,
    payload: RegisterPasswordRequest,
    session: AsyncSession = Depends(get_db),
) -> dict:
    """Register password from Telegram bot after payment."""
    settings: Settings = request.app.state.settings

    # This legacy provisioning route is also guarded by application middleware.
    # Keep an endpoint-level check so it remains fail-closed if the router is ever
    # mounted by another app or test harness.
    api_key = request.headers.get("X-API-Key", "")
    expected_key = settings.backend_api_key.strip()
    if not expected_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Password provisioning is not configured",
        )
    if not hmac.compare_digest(api_key.encode("utf-8"), expected_key.encode("utf-8")):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid API key")

    telegram_id = str(payload.telegram_id)

    # Check if user exists
    user = await get_user_by_telegram_id(session, telegram_id)

    password_hash = get_password_hash(payload.password)
    expires_at = datetime.now(timezone.utc) + timedelta(days=30)

    if user:
        user.hashed_password = password_hash
        user.subscription_expires_at = expires_at
        user.email = payload.login
        user.telegram_username = payload.telegram_username
    else:
        from app.models.user import User
        user = User(
            telegram_id=telegram_id,
            email=payload.login,
            hashed_password=password_hash,
            subscription_expires_at=expires_at,
            telegram_username=payload.telegram_username,
            is_active=True,
        )
        session.add(user)

    await session.commit()
    return {"status": "success", "message": "Password registered"}


@router.post("/login-password", response_model=Token)
async def login_password(
    request: Request,
    payload: LoginPasswordRequest,
    session: AsyncSession = Depends(get_db),
) -> Token:
    """Login with 32-character password"""
    settings: Settings = request.app.state.settings
    ip_address = get_client_ip(request)

    # Rate limiting
    await _rate_limit(
        request,
        key=make_limit_key("password", "login", ip_address),
        limit=5,
        window_seconds=60,
    )

    from app.models.user import User
    from sqlalchemy import select

    result = await session.execute(
        select(User)
        .where(User.hashed_password.isnot(None))
        .where(User.email == payload.login)
    )
    user = result.scalar_one_or_none()

    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid password"
        )

    # Check subscription expiry
    if user.subscription_expires_at and _as_utc(user.subscription_expires_at) < datetime.now(timezone.utc):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Subscription expired"
        )

    user = await sync_login_metadata(session, user, ip_address=ip_address, source="password")
    result = await issue_token_for_user(session, user, settings)
    return _token_response(result)
