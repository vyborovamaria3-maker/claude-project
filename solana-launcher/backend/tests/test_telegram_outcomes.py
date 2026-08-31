from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from app.services.telegram_outcomes import build_outcome_windows


@dataclass
class Metric:
    timestamp: datetime
    price_usd: float | None = None
    market_cap: float | None = None


def test_outcome_windows_use_market_cap_and_do_not_zero_missing_horizons() -> None:
    called = datetime(2026, 1, 1, tzinfo=timezone.utc)
    metrics = [
        Metric(called + timedelta(minutes=4), price_usd=1.1, market_cap=110.0),
        Metric(called + timedelta(minutes=10), price_usd=1.4, market_cap=140.0),
        Metric(called + timedelta(minutes=15), price_usd=1.2, market_cap=120.0),
    ]
    windows = build_outcome_windows(
        metrics,
        called_at=called,
        call_price_usd=1.0,
        call_market_cap_usd=100.0,
    )

    assert windows["5m"]["complete"] is True
    assert windows["5m"]["close_multiple"] == 1.1
    assert windows["15m"]["peak_multiple"] == 1.4
    assert windows["15m"]["close_multiple"] == 1.2
    assert windows["15m"]["final_to_peak"] == round(120 / 140, 6)
    assert windows["1h"]["complete"] is False
    assert windows["1h"]["close_multiple"] == 1.2
    assert windows["1h"]["close_multiple"] != 0


def test_outcome_windows_fall_back_to_price_when_market_cap_baseline_missing() -> None:
    called = datetime(2026, 1, 1, tzinfo=timezone.utc)
    metrics = [
        Metric(called + timedelta(minutes=5), price_usd=2.0, market_cap=None),
        Metric(called + timedelta(minutes=15), price_usd=3.0, market_cap=None),
    ]
    windows = build_outcome_windows(
        metrics,
        called_at=called,
        call_price_usd=1.5,
        call_market_cap_usd=None,
    )

    assert windows["5m"]["baseline_kind"] == "price"
    assert windows["5m"]["close_multiple"] == round(2.0 / 1.5, 6)
    assert windows["15m"]["peak_multiple"] == 2.0


def test_outcome_windows_use_price_when_close_market_cap_is_missing() -> None:
    called = datetime(2026, 1, 1, tzinfo=timezone.utc)
    metrics = [
        Metric(called + timedelta(minutes=4), price_usd=1.1, market_cap=110.0),
        Metric(called + timedelta(minutes=5), price_usd=1.25, market_cap=None),
    ]
    windows = build_outcome_windows(
        metrics,
        called_at=called,
        call_price_usd=1.0,
        call_market_cap_usd=100.0,
    )

    assert windows["5m"]["complete"] is True
    assert windows["5m"]["baseline_kind"] == "price"
    assert windows["5m"]["close_multiple"] == 1.25
    assert windows["5m"]["peak_multiple"] == 1.25


def test_outcome_window_is_not_complete_when_target_sample_is_too_old() -> None:
    called = datetime(2026, 1, 1, tzinfo=timezone.utc)
    metrics = [
        Metric(called + timedelta(minutes=1), price_usd=1.1, market_cap=110.0),
        Metric(called + timedelta(minutes=30), price_usd=1.8, market_cap=180.0),
    ]
    windows = build_outcome_windows(
        metrics,
        called_at=called,
        call_price_usd=1.0,
        call_market_cap_usd=100.0,
    )

    assert windows["15m"]["complete"] is False
    assert windows["15m"]["observed_at"] == (called + timedelta(minutes=1)).isoformat()
    assert windows["15m"]["target_gap_minutes"] == 14.0
    assert windows["15m"]["target_tolerance_minutes"] == 3
