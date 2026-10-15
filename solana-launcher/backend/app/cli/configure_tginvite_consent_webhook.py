"""Operator-only, opt-in Telegram webhook setup; no changes without --apply.

The bot used here must be separate from the application's general Telegram
webhook bot. Never pass or print a bot token as a command-line argument.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import ipaddress
import os
import re
from urllib.parse import urlsplit

import httpx

from app.core.config import Settings, get_settings
from app.services.tginvite_webhook_verify import verify_operator_bindings

TOKEN_PATTERN = re.compile(r"^[1-9][0-9]{4,19}:[A-Za-z0-9_-]{30,}$")
SECRET_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,256}$")
WEBHOOK_PATH = "/api/v1/tginvite/consent-webhook"


class SetupRejected(ValueError):
    """Do not attach upstream errors, request URLs or bot credentials."""


def validate_setup(settings: Settings, public_url: str) -> dict[str, str]:
    try:
        parsed = urlsplit(public_url)
        host = parsed.hostname or ""
        # Only operator-owned public DNS hostnames are allowed; no IP literals,
        # loopback, local names, credentials or unexpected URL paths.
        try:
            ipaddress.ip_address(host)
            is_ip = True
        except ValueError:
            is_ip = False
        if (
            parsed.scheme != "https" or not host or is_ip
            or host == "localhost" or host.endswith((".local", ".test", ".internal"))
            or "." not in host or parsed.username or parsed.password
            or parsed.port not in (None, 443)
            or parsed.path != WEBHOOK_PATH or parsed.query or parsed.fragment
        ):
            raise ValueError("Invalid public URL")
    except ValueError:
        raise SetupRejected("Public HTTPS consent webhook URL is invalid") from None

    secret = settings.tginvite_consent_webhook_secret
    if not SECRET_PATTERN.fullmatch(secret):
        raise SetupRejected("A separate strong consent webhook secret is required")
    try:
        key = base64.b64decode(settings.tginvite_consent_hmac_key, validate=True)
        if len(key) < 32:
            raise SetupRejected("Consent HMAC key must have at least 32 random bytes")
        binding = verify_operator_bindings(
            settings.tginvite_consent_bot_id, settings.tginvite_consent_chat_bindings
        )
    except (ValueError, binascii.Error):
        raise SetupRejected("Consent webhook bot/chat settings are invalid") from None
    return binding.bindings


async def configure_webhook(
    settings: Settings,
    public_url: str,
    *,
    apply: bool,
    bot_token: str | None = None,
) -> None:
    bindings = validate_setup(settings, public_url)
    if not apply:
        print("TGInvite consent configuration validated locally. No Telegram API call made.")
        return
    if not bot_token or not TOKEN_PATTERN.fullmatch(bot_token):
        raise SetupRejected("Dedicated opt-in bot token is required in the environment")
    # An explicit independent bot is required to avoid overwriting the
    # existing application's webhook, which may receive other update types.
    if bot_token == settings.telegram_bot_token:
        raise SetupRejected("Refusing to replace the application's primary bot webhook")

    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
            url = f"https://api.telegram.org/bot{bot_token}/"
            me = (await client.post(url + "getMe")).json()
            info = me.get("result") if isinstance(me, dict) and me.get("ok") is True else None
            if (
                not isinstance(info, dict)
                or info.get("is_bot") is not True
                or str(info.get("id")) != settings.tginvite_consent_bot_id
            ):
                raise SetupRejected("Configured opt-in bot identity does not match Telegram")

            for chat_id in bindings:
                raw = (await client.post(
                    url + "getChatMember",
                    json={"chat_id": chat_id, "user_id": int(settings.tginvite_consent_bot_id)},
                )).json()
                member = (
                    raw.get("result") if isinstance(raw, dict) and raw.get("ok") is True
                    else None
                )
                if (
                    not isinstance(member, dict)
                    or (
                        member.get("status") != "creator"
                        and not (
                            member.get("status") == "administrator"
                            and member.get("can_invite_users") is True
                        )
                    )
                ):
                    raise SetupRejected("Opt-in bot lacks required join-request access")

            confirmation = (await client.post(
                url + "setWebhook",
                json={
                    "url": public_url,
                    "secret_token": settings.tginvite_consent_webhook_secret,
                    "allowed_updates": ["chat_join_request", "message"],
                    "max_connections": 5,
                    "drop_pending_updates": False,
                },
            )).json()
            if (
                not isinstance(confirmation, dict)
                or confirmation.get("ok") is not True
                or confirmation.get("result") is not True
            ):
                raise SetupRejected("Telegram rejected opt-in webhook setup")
    except SetupRejected:
        raise
    except Exception:
        # httpx request URLs contain the bot token. Suppress exception chains
        # instead of leaking HTTP errors or credentials to CLI users/logs.
        raise SetupRejected("Unable to verify or configure Telegram opt-in bot") from None
    print("Dedicated TGInvite consent webhook configured; no invitations sent.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Configure a separate TGInvite consent bot")
    parser.add_argument("--url", required=True, help="Public HTTPS backend consent webhook URL")
    parser.add_argument(
        "--apply", action="store_true",
        help="Actually call Telegram API after verifying bot identity and permissions",
    )
    args = parser.parse_args()
    try:
        asyncio.run(configure_webhook(
            get_settings(), args.url, apply=args.apply,
            bot_token=os.environ.get("TG_INVITE_CONSENT_BOT_TOKEN"),
        ))
    except SetupRejected as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
