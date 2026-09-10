from __future__ import annotations

import argparse
import asyncio
import getpass
from pathlib import Path

from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError
from telethon.sessions import StringSession

from app.core.config import get_settings


_BACKEND_ENV = Path(__file__).resolve().parents[2] / ".env"


def _write_env_value(path: Path, key: str, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = path.read_text(encoding="utf-8-sig") if path.exists() else ""
    lines = existing.splitlines()
    prefix = f"{key}="
    replacement = f"{key}={value}"
    updated: list[str] = []
    replaced = False

    for line in lines:
        if line.strip().startswith(prefix):
            if not replaced:
                updated.append(replacement)
                replaced = True
            continue
        updated.append(line)

    if not replaced:
        if updated and updated[-1].strip():
            updated.append("")
        updated.append(replacement)

    path.write_text("\n".join(updated).rstrip() + "\n", encoding="utf-8")


async def main(*, write_env: bool = False) -> None:
    settings = get_settings()
    if not settings.telegram_api_id or not settings.telegram_api_hash:
        raise SystemExit("TG_API_ID and TG_API_HASH must be configured first")
    phone = input("Telegram phone number (international format): ").strip()
    client = TelegramClient(StringSession(), settings.telegram_api_id, settings.telegram_api_hash)
    await client.connect()
    try:
        sent = await client.send_code_request(phone)
        code = input("Telegram login code: ").strip()
        try:
            await client.sign_in(phone=phone, code=code, phone_code_hash=sent.phone_code_hash)
        except SessionPasswordNeededError:
            password = getpass.getpass("Telegram 2FA password: ")
            await client.sign_in(password=password)
        session_string = client.session.save()
        me = await client.get_me()
        print(f"Authorized as @{getattr(me, 'username', None) or getattr(me, 'id', 'unknown')}")
        if write_env:
            _write_env_value(_BACKEND_ENV, "TG_SESSION_STRING", session_string)
            print(f"TG_SESSION_STRING saved to {_BACKEND_ENV}")
            print("The session secret was not printed. Keep backend/.env private.")
        else:
            print("Set this secret as TG_SESSION_STRING. Do not commit or share it:")
            print(session_string)
    finally:
        await client.disconnect()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Create an authorized Telegram MTProto user session")
    parser.add_argument(
        "--write-env",
        action="store_true",
        help="save TG_SESSION_STRING directly to backend/.env without printing it",
    )
    args = parser.parse_args()
    asyncio.run(main(write_env=args.write_env))
