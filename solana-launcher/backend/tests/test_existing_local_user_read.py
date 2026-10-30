from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4

import pytest
from app.schemas.user import UserCreate, UserRead
from pydantic import ValidationError


def test_existing_local_administrator_can_be_serialized_without_changing_identity():
    identity = SimpleNamespace(
        id=uuid4(), email="existing-admin@potapoff.local", is_active=True,
        is_superuser=True, created_at=datetime.now(UTC), updated_at=datetime.now(UTC),
    )
    result = UserRead.model_validate(identity)
    assert result.id == identity.id
    assert result.email == identity.email
    assert result.is_active is True
    assert result.is_superuser is True


def test_new_user_email_validation_remains_strict():
    with pytest.raises(ValidationError):
        UserCreate(email="invalid-email", password="fixture-password")
