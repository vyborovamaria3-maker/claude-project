import pytest

from app.core.security import verify_password
from app.schemas.user import UserCreate
from app.services.users import create_user, ensure_admin_user


@pytest.mark.asyncio
async def test_admin_bootstrap_refuses_silent_privilege_escalation(test_app):
    settings = test_app.state.settings
    async with test_app.state.sessionmaker() as session:
        await create_user(
            session,
            UserCreate(
                email=settings.admin_username,
                full_name="Existing User",
                password="existing-password-123",
            ),
        )

    with pytest.raises(RuntimeError, match="refusing automatic privilege escalation"):
        await ensure_admin_user(test_app.state.sessionmaker, settings)


@pytest.mark.asyncio
async def test_admin_bootstrap_does_not_reset_existing_superuser_password(test_app):
    settings = test_app.state.settings
    original_password = "original-admin-password-123"
    async with test_app.state.sessionmaker() as session:
        existing = await create_user(
            session,
            UserCreate(
                email=settings.admin_username,
                full_name=settings.admin_display_name,
                password=original_password,
            ),
            is_superuser=True,
        )
        original_hash = existing.hashed_password

    settings.admin_password = "replacement-from-environment-456"
    admin = await ensure_admin_user(test_app.state.sessionmaker, settings)

    assert admin.hashed_password == original_hash
    assert verify_password(original_password, admin.hashed_password)
    assert not verify_password(settings.admin_password, admin.hashed_password)


@pytest.mark.asyncio
async def test_admin_bootstrap_blocks_former_default_password(test_app):
    settings = test_app.state.settings
    former_default = "".join(("Change", "Me", "123!"))
    async with test_app.state.sessionmaker() as session:
        await create_user(
            session,
            UserCreate(
                email=settings.admin_username,
                full_name=settings.admin_display_name,
                password=former_default,
            ),
            is_superuser=True,
        )

    with pytest.raises(RuntimeError, match="legacy default password"):
        await ensure_admin_user(test_app.state.sessionmaker, settings)
