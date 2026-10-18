"""Re-encrypt all stored TGInvite sessions under the currently configured key.

Run with TG_INVITE_SESSION_ENCRYPTION_KEY=new-key and
TG_INVITE_SESSION_PREVIOUS_KEYS=old-key[,older-key]. Stop all session writers
before running; use a database backup and verify success before retiring old keys.

No plaintext credentials or per-owner identifiers are logged.
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.models.telegram_invite_session import TelegramInviteSession
from app.services.telegram_invite_vault import (
    TelegramInviteVaultError,
    _key,
    decrypt_session,
    encrypt_session,
)


async def reencrypt_all(
    db: AsyncSession, active_key: str, previous_keys: tuple[str, ...]
) -> int:
    """All-or-nothing rotation. A single unreadable row rolls back the batch."""
    _key(active_key)
    for previous in previous_keys:
        _key(previous)
    if not previous_keys:
        raise TelegramInviteVaultError("Previous keys are required for explicit rotation")

    result = await db.execute(
        select(TelegramInviteSession).order_by(TelegramInviteSession.id).with_for_update()
    )
    rows = result.scalars().all()
    rotated = 0
    try:
        for row in rows:
            if row.encrypted_payload is None:
                # Revoked-session tombstone; preserve its generation as-is.
                continue
            plaintext = decrypt_session(
                str(row.owner_id), row.encrypted_payload, active_key, previous_keys
            )
            row.encrypted_payload = encrypt_session(str(row.owner_id), plaintext, active_key)
            rotated += 1
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return rotated


async def main_async() -> None:
    settings = get_settings()
    active_key = settings.tginvite_session_encryption_key
    previous = tuple(
        value.strip()
        for value in settings.tginvite_session_previous_keys.split(",")
        if value.strip()
    )
    if not previous or len(previous) > 4:
        raise TelegramInviteVaultError("Configure 1–4 previous keys for rotation")
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    try:
        async with sessionmaker() as db:
            count = await reencrypt_all(db, active_key, previous)
    finally:
        await engine.dispose()
    print(f"Re-encrypted {count} Telegram vault records with active key.")


def main() -> None:
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
