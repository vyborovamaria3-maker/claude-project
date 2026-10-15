"""Strict Telegram join-request verifier for server-owned TGInvite consent evidence.

A join request is an explicit request to join ONE chat; it is not permission
to send unsolicited direct invites or unsolicited future messages.

A Telegram webhook secret proves delivery using the *configured bot*, but
owner/chat authority still comes solely from operator-vetted bindings.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from app.services.tginvite_consent_ledger import VerifiedTelegramOptIn

_CHAT_ID = re.compile(r"^-[1-9][0-9]{0,19}$")
_BOT_ID = re.compile(r"^[1-9][0-9]{0,19}$")
MAX_BINDINGS = 100
MAX_UPDATE_AGE_SECONDS = 24 * 3600
MAX_CLOCK_SKEW_SECONDS = 300


class TelegramWebhookInvalid(ValueError):
    """Reject a malformed or unbound Telegram event without leaking its contents."""


@dataclass(frozen=True)
class TelegramWebhookSettings:
    bot_id: str
    bindings: dict[str, str]


def verify_operator_bindings(bot_id: str, json_bindings: str) -> TelegramWebhookSettings:
    """Require a fixed bot and an allowlist of verified owner/recipient chat pairs.

    This setting is configured solely by a trusted operator after verifying that
    the bot has admin access and that the chat belongs to the owner. Never take
    a binding or owner ID from Telegram update data or from a browser.
    """
    if not isinstance(bot_id, str) or not _BOT_ID.fullmatch(bot_id):
        raise TelegramWebhookInvalid("Consent bot identity is not configured")
    try:
        parsed = json.loads(json_bindings)
    except (TypeError, ValueError) as exc:
        raise TelegramWebhookInvalid("Consent chat bindings are not configured") from exc
    if not isinstance(parsed, dict) or not 1 <= len(parsed) <= MAX_BINDINGS:
        raise TelegramWebhookInvalid("Consent chat bindings are not configured")
    canonical: dict[str, str] = {}
    for chat_id, owner_id in parsed.items():
        if not isinstance(chat_id, str) or not _CHAT_ID.fullmatch(chat_id):
            raise TelegramWebhookInvalid("Invalid configured Telegram chat")
        if not isinstance(owner_id, str):
            raise TelegramWebhookInvalid("Invalid configured Telegram owner")
        try:
            owner = str(UUID(owner_id))
        except ValueError as exc:
            raise TelegramWebhookInvalid("Invalid configured Telegram owner") from exc
        canonical[chat_id] = owner
    return TelegramWebhookSettings(bot_id=bot_id, bindings=canonical)


def verified_join_request(
    update: object,
    *,
    settings: TelegramWebhookSettings,
    now: datetime | None = None,
) -> VerifiedTelegramOptIn | None:
    """Parse a Telegram Bot API Update; ignore every non-join-request update.

    This function requires that the caller FIRST authenticates the webhook
    secret. It cannot be used as public evidence from client-originated JSON.
    """
    if not isinstance(update, dict):
        raise TelegramWebhookInvalid("Malformed Telegram update")
    if not isinstance(update.get("update_id"), int) or isinstance(
        update["update_id"], bool
    ) or update["update_id"] < 0:
        raise TelegramWebhookInvalid("Malformed Telegram update")
    event = update.get("chat_join_request")
    if event is None:
        return None
    if not isinstance(event, dict):
        raise TelegramWebhookInvalid("Malformed Telegram join request")
    chat = event.get("chat")
    requester = event.get("from")
    if not isinstance(chat, dict) or not isinstance(requester, dict):
        raise TelegramWebhookInvalid("Malformed Telegram join request")
    chat_id = chat.get("id")
    recipient_id = requester.get("id")
    date = event.get("date")
    if (
        not isinstance(chat_id, int) or isinstance(chat_id, bool) or chat_id >= 0
        or not isinstance(recipient_id, int) or isinstance(recipient_id, bool)
        or recipient_id <= 0 or requester.get("is_bot") is True
        or not isinstance(date, int) or isinstance(date, bool) or date <= 0
    ):
        raise TelegramWebhookInvalid("Malformed Telegram join request")
    canonical_chat = str(chat_id)
    if not _CHAT_ID.fullmatch(canonical_chat) or not _BOT_ID.fullmatch(str(recipient_id)):
        raise TelegramWebhookInvalid("Malformed Telegram join request")
    owner_id = settings.bindings.get(canonical_chat)
    if owner_id is None:
        raise TelegramWebhookInvalid("Chat is not authorized for consent collection")
    timestamp = int((now or datetime.now(UTC)).timestamp())
    if not timestamp - MAX_UPDATE_AGE_SECONDS <= date <= timestamp + MAX_CLOCK_SKEW_SECONDS:
        raise TelegramWebhookInvalid("Telegram join request is outside the safe age window")
    return VerifiedTelegramOptIn(
        owner_id=owner_id,
        destination_chat_id=canonical_chat,
        recipient_telegram_id=str(recipient_id),
        telegram_bot_id=settings.bot_id,
        telegram_update_id=update["update_id"],
        proof_kind="telegram_chat_join_request",
    )

def verified_direct_invite_request(
    update: object,
    *,
    settings: TelegramWebhookSettings,
    now: datetime | None = None,
) -> VerifiedTelegramOptIn | None:
    """Verify a fresh user-authored private DM: /join -100xxxxxxxxxx.

    The dedicated consent bot receives the user's own authenticated sender ID
    via Telegram's secret-protected webhook. Forwarded messages, group messages,
    unbound destinations and any other commands do not mint consent.
    """
    if not isinstance(update, dict):
        raise TelegramWebhookInvalid("Malformed Telegram update")
    update_id = update.get("update_id")
    if not isinstance(update_id, int) or isinstance(update_id, bool) or update_id < 0:
        raise TelegramWebhookInvalid("Malformed Telegram update")
    message = update.get("message")
    if message is None:
        return None
    if not isinstance(message, dict):
        raise TelegramWebhookInvalid("Malformed Telegram message")
    text = message.get("text")
    if not isinstance(text, str) or len(text) > 128:
        return None
    command = re.fullmatch(r"/join(?:@[A-Za-z][A-Za-z0-9_]{4,31})?\s+(-[1-9][0-9]{0,19})", text.strip())
    if command is None:
        return None
    sender = message.get("from")
    chat = message.get("chat")
    sent_at = message.get("date")
    if not isinstance(sender, dict) or not isinstance(chat, dict):
        raise TelegramWebhookInvalid("Malformed Telegram direct consent")
    telegram_user_id = sender.get("id")
    if (
        not isinstance(telegram_user_id, int)
        or isinstance(telegram_user_id, bool)
        or telegram_user_id <= 0
        or sender.get("is_bot") is True
        or chat.get("type") != "private"
        or chat.get("id") != telegram_user_id
        or not isinstance(sent_at, int)
        or isinstance(sent_at, bool)
    ):
        raise TelegramWebhookInvalid("Malformed Telegram direct consent")
    timestamp = int((now or datetime.now(UTC)).timestamp())
    if not timestamp - MAX_UPDATE_AGE_SECONDS <= sent_at <= timestamp + MAX_CLOCK_SKEW_SECONDS:
        raise TelegramWebhookInvalid("Telegram direct consent is outside the safe age window")
    destination = command.group(1)
    owner_id = settings.bindings.get(destination)
    if owner_id is None:
        raise TelegramWebhookInvalid("Requested chat is not authorized for direct opt-in")
    if not _BOT_ID.fullmatch(str(telegram_user_id)):
        raise TelegramWebhookInvalid("Malformed Telegram user identity")
    return VerifiedTelegramOptIn(
        owner_id=owner_id,
        destination_chat_id=destination,
        recipient_telegram_id=str(telegram_user_id),
        telegram_bot_id=settings.bot_id,
        telegram_update_id=update_id,
        proof_kind="telegram_bot_start",
    )
