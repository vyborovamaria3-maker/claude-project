from datetime import datetime, timezone
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jwt.exceptions import InvalidTokenError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.db.session import get_db
from app.models.user import User
from app.services.users import get_user_by_id

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)
SESSION_COOKIE = "potapoff_access_token"


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


async def get_current_user(
    request: Request,
    token: str | None = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_db),
) -> User:
    settings: Settings = request.app.state.settings
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    resolved_token = token or request.cookies.get(SESSION_COOKIE)
    if not resolved_token:
        raise credentials_exception

    try:
        payload = jwt.decode(resolved_token, settings.secret_key, algorithms=[settings.algorithm])
        subject = payload.get("sub")
        if subject is None:
            raise credentials_exception
        user_id = UUID(str(subject))
    except (InvalidTokenError, ValueError):
        raise credentials_exception from None

    user = await get_user_by_id(session, user_id)
    if user is None or not user.is_active:
        raise credentials_exception
    return user


async def get_current_subscriber(current_user: User = Depends(get_current_user)) -> User:
    """Require an authenticated user with a currently active entitlement.

    Superusers are explicitly allowed so administrative and emergency access does not
    depend on a commercial subscription record. Normal users must have a non-null,
    future subscription expiry. The check is performed for every protected request,
    so an already-issued JWT cannot outlive an expired entitlement.
    """
    if current_user.is_superuser:
        return current_user

    expires_at = current_user.subscription_expires_at
    if expires_at is None or _as_utc(expires_at) <= datetime.now(timezone.utc):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Active subscription required",
        )
    return current_user


async def get_current_superuser(current_user: User = Depends(get_current_user)) -> User:
    if not current_user.is_superuser:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not enough permissions")
    return current_user
