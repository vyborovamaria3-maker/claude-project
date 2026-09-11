from __future__ import annotations

import argparse
import asyncio
import getpass
import os
from pathlib import Path

from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError
from telethon.sessions import StringSession


_BACKEND_ENV = Path(__file__).resolve().parents[2] / ".env"


def _read_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    result: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        result[key] = value
    return result


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


def _valid_api_hash(value: str) -> bool:
    return len(value) == 32 and all(ch in "0123456789abcdefABCDEF" for ch in value)


def _resolve_api_credentials() -> tuple[int, str, bool]:
    file_env = _read_env_file(_BACKEND_ENV)
    raw_api_id = (os.getenv("TG_API_ID") or file_env.get("TG_API_ID") or "").strip()
    api_hash = (os.getenv("TG_API_HASH") or file_env.get("TG_API_HASH") or "").strip()
    prompted = False

    if raw_api_id and not raw_api_id.isdigit():
        print("Existing TG_API_ID is malformed; it will be replaced if --write-env is used.")
        raw_api_id = ""
    if api_hash and not _valid_api_hash(api_hash):
        print("Existing TG_API_HASH is malformed; it will be replaced if --write-env is used.")
        api_hash = ""

    while not raw_api_id:
        candidate = input("Telegram API ID: ").strip()
        if candidate.isdigit():
            raw_api_id = candidate
        else:
            print("API ID must contain digits only.")
        prompted = True

    while not api_hash:
        candidate = getpass.getpass("Telegram API HASH: ").strip()
        if _valid_api_hash(candidate):
            api_hash = candidate
        else:
            print("API HASH must be a 32-character hexadecimal value.")
        prompted = True

    return int(raw_api_id), api_hash, prompted


async def main(*, write_env: bool = False) -> None:
    api_id, api_hash, prompted_credentials = _resolve_api_credentials()

    if write_env and prompted_credentials:
        _write_env_value(_BACKEND_ENV, "TG_API_ID", str(api_id))
        _write_env_value(_BACKEND_ENV, "TG_API_HASH", api_hash)
        print(f"Telegram API credentials saved to {_BACKEND_ENV} without printing the hash.")

    phone = input("Telegram phone number (international format): ").strip()
    if not phone:
        raise SystemExit("Telegram phone number is required")

    client = TelegramClient(StringSession(), api_id, api_hash)
    await client.connect()
    try:
        sent = await client.send_code_request(phone)
        code = input("Telegram login code: ").strip()
        if not code:
            raise SystemExit("Telegram login code is required")
        try:
            await client.sign_in(phone=phone, code=code, phone_code_hash=sent.phone_code_hash)
        except SessionPasswordNeededError:
            password = getpass.getpass("Telegram 2FA password: ")
            await client.sign_in(password=password)

        session_string = client.session.save()
        me = await client.get_me()
        print(f"Authorized as @{getattr(me, 'username', None) or getattr(me, 'id', 'unknown')}")

        if write_env:
            _write_env_value(_BACKEND_ENV, "TG_API_ID", str(api_id))
            _write_env_value(_BACKEND_ENV, "TG_API_HASH", api_hash)
            _write_env_value(_BACKEND_ENV, "TG_SESSION_STRING", session_string)
            print(f"TG_API_ID, TG_API_HASH and TG_SESSION_STRING saved to {_BACKEND_ENV}")
            print("Secret values were not printed. Keep backend/.env private.")
        else:
            print("Telegram session created successfully.")
            print("Re-run with --write-env to save credentials/session without printing secrets.")
    finally:
        await client.disconnect()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Create an authorized Telegram MTProto user session without loading unrelated app settings",
    )
    parser.add_argument(
        "--write-env",
        action="store_true",
        help="save TG_API_ID, TG_API_HASH and TG_SESSION_STRING directly to backend/.env without printing secrets",
    )
    args = parser.parse_args()
    asyncio.run(main(write_env=args.write_env))
