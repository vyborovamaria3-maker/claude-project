from __future__ import annotations

import asyncio
import getpass

from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError
from telethon.sessions import StringSession

from app.core.config import get_settings


async def main() -> None:
    settings = get_settings()
    if not settings.telegram_api_id or not settings.telegram_api_hash:
        raise SystemExit("TG_API_ID and TG_API_HASH must be configured first")
    phone = (
        await asyncio.to_thread(input, "Telegram phone number (international format): ")
    ).strip()
    client = TelegramClient(StringSession(), settings.telegram_api_id, settings.telegram_api_hash)
    await client.connect()
    try:
        sent = await client.send_code_request(phone)
        code = (await asyncio.to_thread(input, "Telegram login code: ")).strip()
        try:
            await client.sign_in(phone=phone, code=code, phone_code_hash=sent.phone_code_hash)
        except SessionPasswordNeededError:
            password = getpass.getpass("Telegram 2FA password: ")
            await client.sign_in(password=password)
        session_string = client.session.save()
        me = await client.get_me()
        print(f"Authorized as @{getattr(me, 'username', None) or getattr(me, 'id', 'unknown')}")
        print("Set this secret as TG_SESSION_STRING. Do not commit or share it:")
        print(session_string)
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
