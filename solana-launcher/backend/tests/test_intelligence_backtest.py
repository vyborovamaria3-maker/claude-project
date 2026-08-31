from __future__ import annotations

from app.services.intelligence_backtest import (
    aggregate_backtest_rows,
    classify_signal_level,
    historical_caller_reputation,
)


def _history_row(*, peak: float, final_to_peak: float, forwarded: bool = False) -> dict:
    return {
        "call_market_cap_usd": 40_000,
        "forwarded": forwarded,
        "meta": {
            "outcome_windows": {
                "24h": {
                    "complete": True,
                    "peak_multiple": peak,
                    "final_to_peak": final_to_peak,
                }
            }
        },
    }


def test_historical_reputation_uses_only_complete_prior_windows() -> None:
    rows = [
        _history_row(peak=3.0, final_to_peak=0.8),
        _history_row(peak=2.2, final_to_peak=0.15),
        {
            "call_market_cap_usd": 20_000,
            "forwarded": False,
            "meta": {"outcome_windows": {"24h": {"complete": False, "peak_multiple": 20.0}}},
        },
    ]
    reputation = historical_caller_reputation(rows)

    assert reputation["evaluated"] == 2
    assert reputation["wins"] == 2
    assert reputation["rugs"] == 1
    assert reputation["avg_peak_multiple"] == 2.6


def test_level_classifier_requires_independent_layers_for_strong_signal() -> None:
    assert classify_signal_level(
        independence_score=82,
        independent_layers=3,
        caller_reputation=70,
        coordination_risk=20,
    ) == "strong"
    assert classify_signal_level(
        independence_score=82,
        independent_layers=1,
        caller_reputation=70,
        coordination_risk=20,
    ) == "wait"
    assert classify_signal_level(
        independence_score=70,
        independent_layers=2,
        caller_reputation=55,
        coordination_risk=40,
    ) == "consider"
    assert classify_signal_level(
        independence_score=35,
        independent_layers=1,
        caller_reputation=20,
        coordination_risk=85,
    ) == "avoid"


def test_aggregate_backtest_rows_keeps_horizon_sample_counts_separate() -> None:
    rows = [
        {
            "level": "strong",
            "independence_score": 80,
            "caller_reputation": 70,
            "outcomes": {
                "5m": {"complete": True, "close_multiple": 1.1, "peak_multiple": 1.2, "drawdown_from_peak_pct": 8},
                "15m": {"complete": True, "close_multiple": 1.3, "peak_multiple": 1.5, "drawdown_from_peak_pct": 13},
                "1h": {"complete": True, "close_multiple": 1.8, "peak_multiple": 2.2, "drawdown_from_peak_pct": 18},
                "4h": {"complete": False, "close_multiple": 2.0, "peak_multiple": 2.5, "drawdown_from_peak_pct": 20},
                "24h": {"complete": False, "close_multiple": None, "peak_multiple": None, "drawdown_from_peak_pct": None},
            },
        }
    ]
    summary = aggregate_backtest_rows(rows)

    assert summary["levels"]["strong"]["windows"]["1h"]["samples"] == 1
    assert summary["levels"]["strong"]["windows"]["4h"]["samples"] == 0
    assert summary["levels"]["strong"]["windows"]["1h"]["two_x_rate"] == 1.0
