"""Key rotation must preserve credentials and never partially migrate a corrupt vault."""

from __future__ import annotations

import base64
from uuid import uuid4

import pytest
from app.cli.rotate_tginvite_vault import reencrypt_all
from app.models.telegram_invite_session import TelegramInviteSession
from app.models.user import User
from app.services.telegram_invite_vault import (
    TelegramInviteVaultError,
    decrypt_session,
    encrypt_session,
)
from sqlalchemy import select

OLD = base64.b64encode(b"o" * 32).decode("ascii")
NEW = base64.b64encode(b"n" * 32).decode("ascii")
BAD = base64.b64encode(b"x" * 32).decode("ascii")
PAYLOAD = {"api_id": 1234, "api_hash": "a" * 32, "session_string": "session-test-secret"}


def test_previous_key_reads_existing_ciphertext_and_validates_wrong_key() -> None:
    encrypted = encrypt_session("owner-one", PAYLOAD, OLD)
    assert decrypt_session("owner-one", encrypted, NEW, (OLD,)) == PAYLOAD
    with pytest.raises(TelegramInviteVaultError):
        decrypt_session("owner-one", encrypted, NEW)
    with pytest.raises(TelegramInviteVaultError):
        decrypt_session("owner-two", encrypted, NEW, (OLD,))
    with pytest.raises(TelegramInviteVaultError):
        decrypt_session("owner-one", encrypted, NEW, (OLD, BAD[:-1]))


@pytest.mark.asyncio
async def test_rotation_reencrypts_all_rows_without_exposing_plaintext(test_app) -> None:
    async with test_app.state.sessionmaker() as db:
        user = User(email=f"rotate-{uuid4()}@example.test")
        db.add(user)
        await db.flush()
        owner = str(user.id)
        old_ciphertext = encrypt_session(owner, PAYLOAD, OLD)
        db.add(TelegramInviteSession(owner_id=owner, encrypted_payload=old_ciphertext))
        await db.commit()

    async with test_app.state.sessionmaker() as db:
        assert await reencrypt_all(db, NEW, (OLD,)) == 1

    async with test_app.state.sessionmaker() as db:
        record = (await db.execute(select(TelegramInviteSession))).scalar_one()
        assert record.encrypted_payload != old_ciphertext
        assert PAYLOAD["session_string"] not in record.encrypted_payload
        assert decrypt_session(owner, record.encrypted_payload, NEW) == PAYLOAD
        with pytest.raises(TelegramInviteVaultError):
            decrypt_session(owner, record.encrypted_payload, OLD)


@pytest.mark.asyncio
async def test_corrupt_row_rolls_back_all_session_rotations(test_app) -> None:
    owners: list[str] = []
    async with test_app.state.sessionmaker() as db:
        for index in range(2):
            user = User(email=f"corrupt-rotate-{uuid4()}-{index}@example.test")
            db.add(user)
            await db.flush()
            owner = str(user.id)
            owners.append(owner)
            ciphertext = (
                encrypt_session(owner, PAYLOAD, OLD) if index == 0 else "v1:invalid"
            )
            db.add(TelegramInviteSession(owner_id=owner, encrypted_payload=ciphertext))
        await db.commit()

    async with test_app.state.sessionmaker() as db:
        before = {
            row.owner_id: row.encrypted_payload
            for row in (await db.execute(select(TelegramInviteSession))).scalars().all()
        }
        with pytest.raises(TelegramInviteVaultError):
            await reencrypt_all(db, NEW, (OLD,))

    async with test_app.state.sessionmaker() as db:
        after = {
            row.owner_id: row.encrypted_payload
            for row in (await db.execute(select(TelegramInviteSession))).scalars().all()
        }
        assert after == before
