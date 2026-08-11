"""Public API for the leakage-safe Social Intelligence backtest."""

from app.services.social_backtest_causal import (
    BacktestReport,
    BacktestSample,
    HistoricalFeatures,
    HistoricalOutcome,
    ThresholdMetrics,
    build_historical_features,
    build_historical_outcome,
    evaluate_samples,
    run_social_backtest,
)

__all__ = [
    "BacktestReport",
    "BacktestSample",
    "HistoricalFeatures",
    "HistoricalOutcome",
    "ThresholdMetrics",
    "build_historical_features",
    "build_historical_outcome",
    "evaluate_samples",
    "run_social_backtest",
]
