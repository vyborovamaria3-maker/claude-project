from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.config import Settings
from app.core.rate_limit import RateLimitResult, make_limit_key
from app.core.security import verify_password
from app.db.session import get_db
from app.middleware.client_ip import get_client_ip
from app.models.user import User
from app.schemas.auth import (
    LinkRequest,
    LoginPasswordRequest,
    LoginRequest,
    TelegramCallbackRequest,
    TelegramCallbackResponse,
    TelegramVerifyRequest,
)
from app.schemas.token import Token
from app.schemas.user import UserCreate, UserRead
from app.services.auth import (
    LoginResult,
    apply_telegram_profile,
    build_phantom_message,
    create_auth_log,
    get_user_by_telegram_id,
    get_user_by_wallet,
    issue_token_for_user,
    merge_user_records,
    sync_login_metadata,
    verify_phantom_signature,
    verify_telegram_init_data,
)
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


def _user_agent(request: Request) -> str | None:
    value = request.headers.get("user-agent", "").strip()
    return value[:512] or None


async def _log_auth_failure(
    session: AsyncSession,
    *,
    event_type: str,
    provider: str,
    ip_address: str | None,
    user_agent: str | None,
    error_message: str,
    user: User | None = None,
    metadata: dict | None = None,
) -> None:
    await create_auth_log(
        session,
        event_type=event_type,
        provider=provider,
        success=False,
        user_id=user.id if user else None,
        telegram_id=user.telegram_id if user else None,
        ip_address=ip_address,
        user_agent=user_agent,
        metadata=metadata,
        error_message=error_message,
    )


async def _issue_or_forbid(
    session: AsyncSession,
    user: User,
    settings: Settings,
    *,
    ip_address: str | None,
    user_agent: str | None,
    provider: str,
) -> LoginResult:
    try:
        return await issue_token_for_user(session, user, settings)
    except PermissionError as exc:
        await _log_auth_failure(
            session,
            event_type=f"{provider}_login",
            provider=provider,
            user=user,
            ip_address=ip_address,
            user_agent=user_agent,
            error_message=str(exc),
            metadata={"reason": "subscription_inactive"},
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Active subscription required",
        ) from exc


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
    user_agent = _user_agent(request)
    await _rate_limit(
        request,
        key=make_limit_key("login", "password", ip_address or "unknown"),
        limit=settings.auth_verify_rate_limit,
        window_seconds=settings.auth_rate_limit_window_seconds,
    )
    user = await authenticate_user(session, form_data.username, form_data.password)
    if user is None:
        await _log_auth_failure(
            session,
            event_type="password_login",
            provider="password",
            ip_address=ip_address,
            user_agent=user_agent,
            error_message="Incorrect credentials",
            metadata={"identifier": form_data.username[:255]},
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect credentials")

    result = await _issue_or_forbid(
        session,
        user,
        settings,
        ip_address=ip_address,
        user_agent=user_agent,
        provider="password",
    )
    await sync_login_metadata(
        session,
        user,
        ip_address=ip_address,
        source="password",
        user_agent=user_agent,
    )
    return _token_response(result)


@router.post("/login-json", response_model=Token)
async def login_json(
    request: Request,
    login_in: LoginRequest,
    session: AsyncSession = Depends(get_db),
) -> Token:
    settings: Settings = request.app.state.settings
    ip_address = get_client_ip(request)
    user_agent = _user_agent(request)
    await _rate_limit(
        request,
        key=make_limit_key("login", "json", ip_address or "unknown"),
        limit=settings.auth_verify_rate_limit,
        window_seconds=settings.auth_rate_limit_window_seconds,
    )
    user = await authenticate_user(session, login_in.email, login_in.password)
    if user is None:
        await _log_auth_failure(
            session,
            event_type="password_login",
            provider="password",
            ip_address=ip_address,
            user_agent=user_agent,
            error_message="Incorrect credentials",
            metadata={"identifier": str(login_in.email)[:255]},
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect credentials")

    result = await _issue_or_forbid(
        session,
        user,
        settings,
        ip_address=ip_address,
        user_agent=user_agent,
        provider="password",
    )
    await sync_login_metadata(
        session,
        user,
        ip_address=ip_address,
        source="password",
        user_agent=user_agent,
    )
    return _token_response(result)


@router.get("/me", response_model=UserRead)
async def me(current_user=Depends(get_current_user)) -> UserRead:
    return UserRead.model_validate(current_user)


@router.post("/telegram/verify", response_model=Token)
async def telegram_verify(
    request: Request,
    payload: TelegramVerifyRequest,
    session: AsyncSession = Depends(get_db),
) -> Token:
    settings: Settings = request.app.state.settings
    ip_address = get_client_ip(request)
    user_agent = _user_agent(request)
    await _rate_limit(
        request,
        key=make_limit_key("telegram", "verify", ip_address or "unknown"),
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
        await _log_auth_failure(
            session,
            event_type="telegram_verify",
            provider="telegram",
            ip_address=ip_address,
            user_agent=user_agent,
            error_message="Invalid Telegram init_data",
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    telegram_id = str(user_data["id"])
    user = await get_user_by_telegram_id(session, telegram_id)
    if user is None:
        await _log_auth_failure(
            session,
            event_type="telegram_verify",
            provider="telegram",
            ip_address=ip_address,
            user_agent=user_agent,
            error_message="Telegram account has no active site access",
            metadata={"telegram_id": telegram_id},
        )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Active subscription required")

    try:
        apply_telegram_profile(user, user_data)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials") from exc
    session.add(user)

    result = await _issue_or_forbid(
        session,
        user,
        settings,
        ip_address=ip_address,
        user_agent=user_agent,
        provider="telegram",
    )
    await sync_login_metadata(
        session,
        user,
        ip_address=ip_address,
        source="telegram",
        user_agent=user_agent,
    )
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
    user_agent = _user_agent(request)

    if payload.wallet_address and payload.signature and payload.nonce is not None:
        await _rate_limit(
            request,
            key=make_limit_key("link", "wallet", ip_address or "unknown", current_user.id, payload.wallet_address),
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

        nonce_expiry = wallet_user.nonce_expires_at
        if nonce_expiry.tzinfo is None:
            nonce_expiry = nonce_expiry.replace(tzinfo=timezone.utc)
        if wallet_user.nonce != payload.nonce or nonce_expiry < datetime.now(timezone.utc):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

        current_user.wallet_address = payload.wallet_address
        current_user.nonce = None
        current_user.nonce_expires_at = None
        session.add(current_user)
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
            user_agent=user_agent,
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

        try:
            apply_telegram_profile(current_user, user_data)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
        session.add(current_user)
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
            user_agent=user_agent,
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
    user_agent = _user_agent(request)

    try:
        user_data, _ = verify_telegram_init_data(
            init_data=payload.init_data,
            bot_token=settings.telegram_bot_token,
            max_age_hours=settings.telegram_auth_max_age_hours,
        )
    except ValueError:
        await _log_auth_failure(
            session,
            event_type="telegram_callback",
            provider="telegram",
            ip_address=ip_address,
            user_agent=user_agent,
            error_message="Invalid Telegram init_data",
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    telegram_id = str(user_data["id"])
    user = await get_user_by_telegram_id(session, telegram_id)
    if user is None:
        await _log_auth_failure(
            session,
            event_type="telegram_callback",
            provider="telegram",
            ip_address=ip_address,
            user_agent=user_agent,
            error_message="Telegram account has no active site access",
            metadata={"telegram_id": telegram_id},
        )
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Active subscription required")

    try:
        apply_telegram_profile(user, user_data)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials") from exc
    session.add(user)

    result = await _issue_or_forbid(
        session,
        user,
        settings,
        ip_address=ip_address,
        user_agent=user_agent,
        provider="telegram",
    )
    await sync_login_metadata(
        session,
        user,
        ip_address=ip_address,
        source="telegram",
        user_agent=user_agent,
    )

    redirect_url = f"{settings.frontend_url}/?token={result.access_token}"
    return TelegramCallbackResponse(
        access_token=result.access_token,
        expires_in=result.expires_in,
        redirect_url=redirect_url,
    )


@router.post("/login-password", response_model=Token)
async def login_password(
    request: Request,
    payload: LoginPasswordRequest,
    session: AsyncSession = Depends(get_db),
) -> Token:
    """Login with a backend-issued 32-character subscription password."""
    settings: Settings = request.app.state.settings
    ip_address = get_client_ip(request)
    user_agent = _user_agent(request)

    await _rate_limit(
        request,
        key=make_limit_key("password", "login", ip_address or "unknown"),
        limit=5,
        window_seconds=60,
    )

    result = await session.execute(
        select(User)
        .where(User.hashed_password.isnot(None))
        .where(User.access_login == payload.login)
    )
    user = result.scalar_one_or_none()

    if not user or not user.hashed_password or not verify_password(payload.password, user.hashed_password):
        await _log_auth_failure(
            session,
            event_type="password_login",
            provider="password",
            ip_address=ip_address,
            user_agent=user_agent,
            error_message="Invalid credentials",
            user=user,
            metadata={"login": payload.login},
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid password")

    token_result = await _issue_or_forbid(
        session,
        user,
        settings,
        ip_address=ip_address,
        user_agent=user_agent,
        provider="password",
    )
    await sync_login_metadata(
        session,
        user,
        ip_address=ip_address,
        source="password",
        user_agent=user_agent,
    )
    return _token_response(token_result)
