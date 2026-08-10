from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_password_hash, verify_password
from app.models.user import User
from app.schemas.user import UserCreate


async def get_user_by_email(
    session: AsyncSession,
    email: str,
) -> User | None:
    statement = select(User).where(User.email == email)
    result = await session.execute(statement)
    return result.scalar_one_or_none()


async def get_user_by_id(session: AsyncSession, user_id) -> User | None:
    return await session.get(User, str(user_id))


async def create_user(
    session: AsyncSession,
    user_in: UserCreate,
    *,
    is_superuser: bool = False,
) -> User:
    existing_user = await get_user_by_email(session, user_in.email)
    if existing_user is not None:
        raise ValueError("User with this email already exists")

    user = User(
        email=user_in.email,
        full_name=user_in.full_name,
        hashed_password=get_password_hash(user_in.password),
        is_active=True,
        is_superuser=is_superuser,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user


async def authenticate_user(
    session: AsyncSession,
    email: str,
    password: str,
) -> User | None:
    user = await get_user_by_email(session, email)
    hashed_password = user.hashed_password if user else None
    if (
        user is None
        or not hashed_password
        or not verify_password(password, hashed_password)
    ):
        return None
    return user


async def ensure_admin_user(sessionmaker, settings) -> User:
    async with sessionmaker() as session:
        existing_user = await get_user_by_email(
            session,
            settings.admin_username,
        )
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
