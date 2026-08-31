from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.services.telegram_signal_analysis import (
    analyze_coordination_events,
    build_caller_reputation,
)


NOW = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)


def test_coordination_detector_separates_repost_from_late_independent_source() -> None:
    events = [
        {
            "source_handle": "alpha_calls",
            "text": "New Solana gem entry now CA 3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump",
            "occurred_at": NOW,
            "payload": {},
        },
        {
            "source_handle": "copy_calls",
            "text": "New Solana gem entry now CA 3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump",
            "occurred_at": NOW + timedelta(minutes=2),
            "payload": {"forwarded_from": "alpha_calls"},
        },
        {
            "source_handle": "independent_calls",
            "text": "I found this mint from on-chain volume, watching the holder distribution",
            "occurred_at": NOW + timedelta(minutes=22),
            "payload": {},
        },
    ]

    result = analyze_coordination_events(events)

    assert result["sources"] == 3
    assert result["coordinated_sources"] == 1
    assert result["independent_sources"] == 2
    assert result["leader"] == "alpha_calls"
    assert result["burst_sources_5m"] == 2
    assert result["coordination_risk"] > 0
    assert result["source_independence_score"] < 100


def test_coordination_detector_deduplicates_multiple_messages_from_same_source() -> None:
    events = [
        {
            "source_handle": "alpha",
            "text": "first post",
            "occurred_at": NOW,
            "payload": {},
        },
        {
            "source_handle": "alpha",
            "text": "second post",
            "occurred_at": NOW + timedelta(minutes=1),
            "payload": {},
        },
    ]

    result = analyze_coordination_events(events)
    assert result["sources"] == 1
    assert result["independent_sources"] == 1
    assert result["coordinated_sources"] == 0


def test_coordination_detector_recognizes_forward_flag_without_source_name() -> None:
    events = [
        {
            "source_handle": "alpha",
            "text": "original discovery",
            "occurred_at": NOW,
            "payload": {},
        },
        {
            "source_handle": "relay",
            "text": "different caption so similarity alone is insufficient",
            "occurred_at": NOW + timedelta(minutes=3),
            "payload": {"is_forwarded": True, "forwarded_from_id": 123456},
        },
    ]

    result = analyze_coordination_events(events)
    assert result["sources"] == 2
    assert result["coordinated_sources"] == 1
    assert result["independent_sources"] == 1


def test_caller_reputation_rewards_early_original_caller_over_reposter() -> None:
    rows = [
        {
            "username": "alpha",
            "mint_address": "mint-a",
            "called_at": NOW,
            "outcome": "win",
            "roi_multiple": 3.0,
            "call_market_cap_usd": 20_000,
            "forwarded_from": None,
        },
        {
            "username": "copy",
            "mint_address": "mint-a",
            "called_at": NOW + timedelta(minutes=12),
            "outcome": "win",
            "roi_multiple": 2.0,
            "call_market_cap_usd": 80_000,
            "forwarded_from": "alpha",
        },
        {
            "username": "alpha",
            "mint_address": "mint-b",
            "called_at": NOW + timedelta(hours=1),
            "outcome": "win",
            "roi_multiple": 4.0,
            "call_market_cap_usd": 25_000,
            "forwarded_from": None,
        },
        {
            "username": "copy",
            "mint_address": "mint-b",
            "called_at": NOW + timedelta(hours=1, minutes=20),
            "outcome": "rug",
            "roi_multiple": 0.2,
            "call_market_cap_usd": 100_000,
            "forwarded_from": "alpha",
        },
    ]

    result = {row["username"]: row for row in build_caller_reputation(rows)}
    alpha = result["alpha"]
    copy = result["copy"]

    assert alpha["first_calls"] == 2
    assert alpha["median_lead_minutes"] == 16.0
    assert alpha["repost_rate"] == 0.0
    assert alpha["originality_score"] > copy["originality_score"]
    assert alpha["timing_score"] > copy["timing_score"]
    assert alpha["reputation_score"] > copy["reputation_score"]
    assert copy["repost_rate"] == 1.0


def test_caller_reputation_includes_complete_temporal_outcome_windows() -> None:
    def windows(close_1h: float, peak_1h: float, close_24h: float, peak_24h: float) -> dict:
        return {
            "outcome_windows": {
                "1h": {
                    "complete": True,
                    "close_multiple": close_1h,
                    "peak_multiple": peak_1h,
                },
                "24h": {
                    "complete": True,
                    "close_multiple": close_24h,
                    "peak_multiple": peak_24h,
                },
            }
        }

    rows = [
        {
            "username": "alpha",
            "mint_address": "mint-a",
            "called_at": NOW,
            "outcome": "win",
            "roi_multiple": 2.5,
            "call_market_cap_usd": 25_000,
            "forwarded_from": None,
            "meta": windows(1.4, 2.1, 1.8, 3.0),
        },
        {
            "username": "alpha",
            "mint_address": "mint-b",
            "called_at": NOW + timedelta(hours=2),
            "outcome": "win",
            "roi_multiple": 2.0,
            "call_market_cap_usd": 35_000,
            "forwarded_from": None,
            "meta": windows(1.2, 1.8, 1.3, 2.2),
        },
    ]

    alpha = build_caller_reputation(rows)[0]
    assert alpha["outcome_windows"]["1h"]["samples"] == 2
    assert alpha["outcome_windows"]["1h"]["median_close_multiple"] == 1.3
    assert alpha["outcome_windows"]["24h"]["two_x_rate"] == 1.0
    assert alpha["temporal_outcome_score"] is not None


def test_caller_reputation_can_exclude_current_mint_from_its_own_history() -> None:
    historical_meta = {
        "outcome_windows": {
            "1h": {"complete": True, "close_multiple": 0.8, "peak_multiple": 1.0},
            "24h": {"complete": True, "close_multiple": 0.7, "peak_multiple": 1.1},
        }
    }
    current_meta = {
        "outcome_windows": {
            "1h": {"complete": True, "close_multiple": 8.0, "peak_multiple": 10.0},
            "24h": {"complete": True, "close_multiple": 5.0, "peak_multiple": 12.0},
        }
    }
    rows = [
        {
            "username": "alpha",
            "mint_address": "old-mint",
            "called_at": NOW - timedelta(days=2),
            "outcome": "loss",
            "roi_multiple": 1.1,
            "call_market_cap_usd": 40_000,
            "forwarded_from": None,
            "meta": historical_meta,
        },
        {
            "username": "alpha",
            "mint_address": "current-mint",
            "called_at": NOW,
            "outcome": "win",
            "roi_multiple": 12.0,
            "call_market_cap_usd": 20_000,
            "forwarded_from": None,
            "meta": current_meta,
        },
    ]

    all_history = build_caller_reputation(rows)[0]
    prior_only = build_caller_reputation(rows, exclude_mint="current-mint")[0]

    assert all_history["calls"] == 2
    assert prior_only["calls"] == 1
    assert prior_only["unique_mints"] == 1
    assert prior_only["outcome_windows"]["1h"]["median_close_multiple"] == 0.8
    assert prior_only["reputation_score"] < all_history["reputation_score"]
