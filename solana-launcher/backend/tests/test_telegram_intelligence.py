from datetime import datetime, timedelta, timezone

from app.services.social_filters import filter_timeline_payload, social_event_engagement
from app.services.social_intelligence import score_channel_metrics
from app.services.telegram_parser import extract_solana_addresses, is_solana_address, parse_telegram_message

ADDR = "3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump"


def test_solana_address_parser() -> None:
    assert is_solana_address(ADDR)
    assert extract_solana_addresses(f"CA: {ADDR}") == [ADDR]


def test_telegram_parser_extracts_cross_platform_links_and_call() -> None:
    parsed = parse_telegram_message(
        f"100x gem $TEST CA {ADDR} mirror https://t.me/rqcrypt and https://x.com/solana"
    )
    assert parsed.addresses == [ADDR]
    assert parsed.tickers == ["TEST"]
    assert "rqcrypt" in parsed.telegram_usernames
    assert parsed.x_usernames == ["solana"]
    assert parsed.explicit_call is True


def test_score_penalizes_rugs() -> None:
    clean = score_channel_metrics(calls=20, evaluated=10, wins=8, rugs=0, early=10, avg_roi=5.0)
    risky = score_channel_metrics(calls=20, evaluated=10, wins=8, rugs=5, early=10, avg_roi=5.0)
    assert clean > risky
    assert 0 <= risky <= 100


def test_social_event_engagement_uses_platform_metrics() -> None:
    assert social_event_engagement({"platform": "telegram", "metrics": {"reactions": 4, "forwards": 3, "replies": 2, "views": 999}}) == 9
    assert social_event_engagement({"platform": "x", "metrics": {"likes": 4, "retweets": 3, "replies": 2, "views": 999}}) == 9


def test_timeline_filters_by_window_source_score_and_explicit_call() -> None:
    now = datetime(2026, 8, 8, 12, 0, tzinfo=timezone.utc)
    payload = {
        "mint_address": ADDR,
        "timeline": [
            {
                "platform": "telegram",
                "source_handle": "alpha_calls",
                "source_name": "Alpha Calls",
                "occurred_at": now - timedelta(hours=2),
                "metrics": {"reactions": 6, "forwards": 2, "replies": 1, "explicit_call": True},
                "text": "gem call",
            },
            {
                "platform": "telegram",
                "source_handle": "weak_room",
                "source_name": "Weak Room",
                "occurred_at": now - timedelta(hours=1),
                "metrics": {"reactions": 10, "forwards": 5, "replies": 2, "explicit_call": True},
                "text": "another call",
            },
            {
                "platform": "telegram",
                "source_handle": "alpha_calls",
                "source_name": "Alpha Calls",
                "occurred_at": now - timedelta(hours=30),
                "metrics": {"reactions": 20, "forwards": 5, "replies": 2, "explicit_call": True},
                "text": "old call",
            },
            {
                "platform": "x",
                "source_handle": "someone",
                "source_name": None,
                "occurred_at": now - timedelta(hours=1),
                "metrics": {"likes": 100, "retweets": 20, "replies": 5},
                "text": "x mention",
            },
        ],
    }

    filtered = filter_timeline_payload(
        payload,
        platform="telegram",
        hours=24,
        sources={"@alpha_calls"},
        explicit_calls_only=True,
        min_engagement=5,
        min_channel_score=50,
        channel_scores={"alpha_calls": 82, "weak_room": 10},
        limit=20,
        now=now,
    )

    assert filtered["mentions"] == 1
    assert filtered["platforms"] == {"telegram": 1}
    assert filtered["timeline"][0]["source_handle"] == "alpha_calls"
    assert filtered["timeline"][0]["rank"] == 1
