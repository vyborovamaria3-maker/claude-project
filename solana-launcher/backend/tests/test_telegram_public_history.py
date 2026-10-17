"""Non-network checks for safe, bounded history normalization."""

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from app.services.telegram_collector.user_history import (
    normalize_public_channel,
    safe_message_record,
)


def test_accepts_only_public_channel_usernames():
    assert normalize_public_channel("@ExampleChannel") == "ExampleChannel"
    assert normalize_public_channel("PublicGroup_1") == "PublicGroup_1"
    for value in ("https://t.me/+secret", "https://t.me/joinchat/abc", "@x", "", "../chat"):
        with pytest.raises(ValueError):
            normalize_public_channel(value)


def test_message_records_exclude_sensitive_sender_fields():
    source = SimpleNamespace(
        id=42,
        message="A public update",
        date=datetime(2026, 10, 14, tzinfo=UTC),
        views=15,
        forwards=2,
        sender_id=123456789,
        phone="not-for-export",
        access_hash=999999,
    )
    row = safe_message_record(source)
    assert row["message_id"] == 42
    assert row["text"] == "A public update"
    assert set(row) == {"message_id", "text", "published_at", "views", "forwards"}
