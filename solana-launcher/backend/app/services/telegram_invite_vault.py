"""AES-GCM encrypted Telegram user-session payloads, tied to the authenticated owner."""

from __future__ import annotations

import base64
import binascii
import json
import os
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


class TelegramInviteVaultError(ValueError):
    pass


def _key(configured_key: str) -> bytes:
    if not configured_key:
        raise TelegramInviteVaultError("TG_INVITE_SESSION_ENCRYPTION_KEY is not configured")
    try:
        raw = base64.b64decode(configured_key, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise TelegramInviteVaultError("Invalid Telegram vault key") from exc
    if len(raw) != 32:
        raise TelegramInviteVaultError("Telegram vault key must be 32 bytes, base64 encoded")
    return raw


def encrypt_session(owner_id: str, payload: dict[str, Any], configured_key: str) -> str:
    nonce = os.urandom(12)
    plaintext = json.dumps(payload, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    ciphertext = AESGCM(_key(configured_key)).encrypt(
        nonce, plaintext, owner_id.encode("utf-8")
    )
    return "v1:" + base64.b64encode(nonce + ciphertext).decode("ascii")


def decrypt_session(
    owner_id: str,
    encrypted: str,
    configured_key: str,
    previous_keys: tuple[str, ...] = (),
) -> dict[str, Any]:
    """Read v1 payloads with the active key, then explicit rotation fallback keys.

    Writing always uses the primary key. Previous keys must be removed only
    after all vault rows have been re-encrypted with the new active key.
    """
    if not encrypted.startswith("v1:"):
        raise TelegramInviteVaultError("Unsupported Telegram vault payload version")
    try:
        combined = base64.b64decode(encrypted[3:], validate=True)
        if len(combined) < 29:
            raise ValueError("Ciphertext too short")
        # Validate *all* configured keys, not just the first matching key.
        keyring = tuple(_key(key) for key in (configured_key, *previous_keys))
        for raw_key in keyring:
            try:
                plaintext = AESGCM(raw_key).decrypt(
                    combined[:12], combined[12:], owner_id.encode("utf-8")
                )
            except Exception:
                continue
            try:
                data = json.loads(plaintext)
            except (ValueError, TypeError) as exc:
                raise TelegramInviteVaultError("Invalid Telegram vault payload") from exc
            if not isinstance(data, dict):
                raise TelegramInviteVaultError("Invalid Telegram vault payload")
            return data
        raise TelegramInviteVaultError("Unable to decrypt Telegram vault payload")
    except (ValueError, TypeError) as exc:
        raise TelegramInviteVaultError("Invalid Telegram vault payload") from exc
