from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.services.social_filters import filter_timeline_payload


def test_timeline_meta_preserves_prelimit_counts_and_first_match() -> None:
    now = datetime(2026, 8, 12, 16, 0, tzinfo=timezone.utc)
    payload = {
        "mint_address": "3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump",
        "timeline": [
            {
                "platform": "telegram",
                "source_handle": f"channel_{index % 3}",
                "occurred_at": now - timedelta(minutes=10 - index),
                "event_type": "token_call" if index % 2 == 0 else "token_mention",
                "metrics": {"explicit_call": index % 2 == 0},
            }
            for index in range(10)
        ],
    }
    result = filter_timeline_payload(payload, platform="telegram", limit=4, now=now)
    assert result["mentions"] == 4
    assert result["meta"]["matchedBeforeLimit"] == 10
    assert result["meta"]["returned"] == 4
    assert result["meta"]["truncated"] is True
    assert result["meta"]["uniqueSourcesBeforeLimit"] == 3
    assert result["meta"]["explicitTelegramCallsBeforeLimit"] == 5
    assert result["meta"]["firstMatchedAt"] == payload["timeline"][0]["occurred_at"]
