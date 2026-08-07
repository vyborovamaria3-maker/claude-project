from __future__ import annotations

import re
from dataclasses import dataclass

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
ADDRESS_RE = re.compile(r"(?<![1-9A-HJ-NP-Za-km-z])([1-9A-HJ-NP-Za-km-z]{32,44})(?![1-9A-HJ-NP-Za-km-z])")
TG_LINK_RE = re.compile(r"(?:https?://)?t\.me/(?:s/)?([A-Za-z0-9_]{5,32})(?:\b|/)", re.I)
TG_AT_RE = re.compile(r"(?<![\w@])@([A-Za-z0-9_]{5,32})\b")
X_LINK_RE = re.compile(r"(?:https?://)?(?:www\.)?(?:x|twitter)\.com/([A-Za-z0-9_]{1,15})(?:\b|/)", re.I)
TICKER_RE = re.compile(r"(?<!\w)\$([A-Za-z][A-Za-z0-9_]{1,11})\b")
CALL_RE = re.compile(
    r"\b(call|calling|gem|alpha|ape|aping|entry|buy|send(?:ing)?|moon|moonshot|100x|50x|20x|10x|cto|stealth|launch)\b",
    re.I,
)
X_RESERVED = {"home", "explore", "search", "notifications", "messages", "settings", "compose", "intent", "share", "hashtag", "i"}
TG_RESERVED = {"share", "addstickers", "proxy", "socks", "iv"}


@dataclass(frozen=True, slots=True)
class ParsedTelegramMessage:
    addresses: list[str]
    tickers: list[str]
    telegram_usernames: list[str]
    x_usernames: list[str]
    explicit_call: bool


def _decode_base58(value: str) -> bytes:
    number = 0
    for char in value:
        number = number * 58 + ALPHABET.index(char)
    decoded = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    return b"\0" * (len(value) - len(value.lstrip("1"))) + decoded


def is_solana_address(value: str) -> bool:
    try:
        return len(_decode_base58(value)) == 32
    except ValueError:
        return False


def extract_solana_addresses(text: str) -> list[str]:
    return list(dict.fromkeys(value for value in ADDRESS_RE.findall(text or "") if is_solana_address(value)))


def parse_telegram_message(text: str) -> ParsedTelegramMessage:
    text = text or ""
    explicit_tg = {item.lower() for item in TG_LINK_RE.findall(text) if item.lower() not in TG_RESERVED}
    x_users = {item.lower() for item in X_LINK_RE.findall(text) if item.lower() not in X_RESERVED}

    # Bare @handles in Telegram are usually Telegram users/channels. Explicit X links stay
    # separate so graph discovery does not accidentally enqueue every mention into X.
    tg_users = explicit_tg | {item.lower() for item in TG_AT_RE.findall(text) if item.lower() not in TG_RESERVED}
    tickers = sorted({ticker.upper() for ticker in TICKER_RE.findall(text)})
    addresses = extract_solana_addresses(text)
    return ParsedTelegramMessage(
        addresses=addresses,
        tickers=tickers,
        telegram_usernames=sorted(tg_users),
        x_usernames=sorted(x_users),
        explicit_call=bool(addresses and CALL_RE.search(text)),
    )
