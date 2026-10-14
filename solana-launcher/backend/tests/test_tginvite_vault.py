"""Vault does not disclose plaintext at rest and prevents cross-owner substitution."""

from __future__ import annotations

import base64

import pytest

from app.services.telegram_invite_vault import (
    TelegramInviteVaultError,
    decrypt_session,
    encrypt_session,
)

TEST_KEY = base64.b64encode(b"v" * 32).decode("ascii")
PAYLOAD = {
    "api_id": 1234,
    "api_hash": "a" * 32,
    "session_string": "session-string-test-value",
}


def test_encryption_roundtrip_and_unique_nonces() -> None:
    first = encrypt_session("owner-1", PAYLOAD, TEST_KEY)
    second = encrypt_session("owner-1", PAYLOAD, TEST_KEY)
    assert first != second
    assert "session-string-test-value" not in first
    assert decrypt_session("owner-1", first, TEST_KEY) == PAYLOAD


def test_cross_owner_and_wrong_key_rejected() -> None:
    result = encrypt_session("owner-1", PAYLOAD, TEST_KEY)
    with pytest.raises(TelegramInviteVaultError):
        decrypt_session("owner-2", result, TEST_KEY)
    with pytest.raises(TelegramInviteVaultError):
        decrypt_session("owner-1", result, base64.b64encode(b"z" * 32).decode())


def test_missing_or_invalid_key_fail_closed() -> None:
    with pytest.raises(TelegramInviteVaultError):
        encrypt_session("owner-1", PAYLOAD, "")
    with pytest.raises(TelegramInviteVaultError):
        encrypt_session("owner-1", PAYLOAD, "incorrect")
    with pytest.raises(TelegramInviteVaultError):
        decrypt_session("owner-1", "legacy-ciphertext", TEST_KEY)
