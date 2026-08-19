from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from app.services.social_backtest import (
    BacktestSample,
    HistoricalFeatures,
    HistoricalOutcome,
    build_historical_features,
    build_historical_outcome,
    evaluate_samples,
)

NOW = datetime(2026, 8, 1, 12, 0, tzinfo=UTC)
MINT = "3jX8p8QumtfccakGib95yi4pPDNgQnDJEMmwjk1Upump"


def event(platform: str, minutes_ago: int, *, source: str, text: str, metrics: dict | None = None):
    return SimpleNamespace(
        platform=platform,
        source_handle=source,
        source_name=source,
        text=text,
        event_type="token_mention",
        occurred_at=NOW - timedelta(minutes=minutes_ago),
        metrics=metrics or {},
    )


def call(hours_ago: int, outcome: str, *, channel_id: int = 1, roi: float = 2.5, window: int = 72):
    return SimpleNamespace(
        called_at=NOW - timedelta(hours=hours_ago),
        outcome=outcome,
        is_explicit_call=True,
        call_market_cap_usd=40_000,
        roi_multiple=roi,
        channel_id=channel_id,
        meta={"evaluation_window_hours": window},
    )


def metric(hours_after: float, price: float):
    return SimpleNamespace(timestamp=NOW + timedelta(hours=hours_after), price_usd=price)


def test_channel_reputation_uses_only_matured_prior_calls() -> None:
    events = [
        event("telegram", 10, source="alpha", text="early gem", metrics={"explicit_call": True})
    ]
    immature = call(10, "win")
    matured = call(100, "win")
    without = build_historical_features(
        mint=MINT,
        cutoff=NOW,
        creation_date=NOW - timedelta(hours=2),
        events=events,
        prior_calls_by_channel={1: [immature]},
    )
    with_history = build_historical_features(
        mint=MINT,
        cutoff=NOW,
        creation_date=NOW - timedelta(hours=2),
        events=events,
        prior_calls_by_channel={1: [immature, matured]},
    )
    assert without.historical_channels == 0
    assert without.channel_score == 0
    assert with_history.historical_channels == 1
    assert with_history.channel_score > 0
    assert with_history.channel_win_rate == 100
    assert with_history.tg_score > without.tg_score


def test_missing_x_does_not_receive_clean_x_bonus() -> None:
    features = build_historical_features(
        mint=MINT,
        cutoff=NOW,
        creation_date=NOW - timedelta(hours=1),
        events=[
            event("telegram", 10, source="alpha", text="early gem", metrics={"explicit_call": True})
        ],
        prior_calls_by_channel={},
    )
    assert features.x_mentions == 0
    assert features.x_score == 0


def test_mutable_x_metrics_are_excluded_from_causal_features() -> None:
    common = [
        event(
            "x",
            20,
            source="verified",
            text="organic research",
            metrics={"verified": True, "likes": 10},
        ),
        event(
            "x",
            10,
            source="plain",
            text="different discussion",
            metrics={"verified": False, "likes": 5},
        ),
    ]
    inflated = [
        event(
            "x",
            20,
            source="verified",
            text="organic research",
            metrics={"verified": True, "likes": 9_999_999, "views": 99_999_999},
        ),
        event(
            "x",
            10,
            source="plain",
            text="different discussion",
            metrics={"verified": True, "likes": 8_888_888, "views": 88_888_888},
        ),
    ]
    base = build_historical_features(
        mint=MINT, cutoff=NOW, creation_date=None, events=common, prior_calls_by_channel={}
    )
    future = build_historical_features(
        mint=MINT, cutoff=NOW, creation_date=None, events=inflated, prior_calls_by_channel={}
    )
    assert base.x_verified_ratio == 0
    assert base.x_engagement == 0
    assert base.x_score == future.x_score
    assert base.core_social_score == future.core_social_score


def test_missing_channel_history_is_not_perfect_safety() -> None:
    events = [event("telegram", 10, source="alpha", text="call", metrics={"explicit_call": True})]
    no_history = build_historical_features(
        mint=MINT, cutoff=NOW, creation_date=None, events=events, prior_calls_by_channel={}
    )
    good_history = build_historical_features(
        mint=MINT,
        cutoff=NOW,
        creation_date=None,
        events=events,
        prior_calls_by_channel={1: [call(120, "win"), call(200, "win")]},
    )
    assert no_history.historical_channels == 0
    assert good_history.historical_channels == 1
    assert good_history.tg_score > no_history.tg_score


def test_promotional_copy_paste_raises_risk() -> None:
    clean = [
        event("x", 20, source="a", text="organic research discussion"),
        event("x", 15, source="b", text="different token research"),
    ]
    spam = [
        event("x", 20, source="a", text="100x gem buy now repeated message"),
        event("x", 15, source="b", text="100x gem buy now repeated message"),
    ]
    clean_features = build_historical_features(
        mint=MINT, cutoff=NOW, creation_date=None, events=clean, prior_calls_by_channel={}
    )
    spam_features = build_historical_features(
        mint=MINT, cutoff=NOW, creation_date=None, events=spam, prior_calls_by_channel={}
    )
    assert spam_features.social_risk > clean_features.social_risk
    assert spam_features.organic_score < clean_features.organic_score


def test_outcome_requires_price_near_cutoff_without_saved_call_price() -> None:
    assert (
        build_historical_outcome(
            cutoff=NOW,
            metrics=[metric(2, 1.0), metric(3, 2.0)],
            horizon_hours=72,
            baseline_tolerance_minutes=30,
        )
        is None
    )


def test_saved_call_price_does_not_bypass_causal_baseline() -> None:
    result = build_historical_outcome(
        cutoff=NOW,
        metrics=[
            metric(1, 1.4),
            metric(6, 2.2),
            metric(24, 1.8),
        ],
        horizon_hours=72,
        baseline_price=1.0,
    )
    assert result is None


def test_only_near_cutoff_baseline_and_horizon_coverage_are_used() -> None:
    result = build_historical_outcome(
        cutoff=NOW,
        metrics=[
            metric(-2, 100.0),
            metric(-0.05, 1.0),
            metric(6, 2.1),
            metric(72, 1.5),
        ],
        horizon_hours=72,
    )
    assert result is not None
    assert result.baseline_price == 1.0
    assert result.max_multiple == 2.1


def feature(value: float, risk: float = 20) -> HistoricalFeatures:
    return HistoricalFeatures(
        cutoff=NOW,
        mint=MINT,
        x_mentions=1,
        x_authors=1,
        x_verified_ratio=0,
        x_suspicious_ratio=0,
        x_engagement=0,
        tg_mentions=1,
        tg_channels=1,
        tg_explicit_calls=1,
        historical_channels=1,
        channel_score=50,
        channel_win_rate=50,
        channel_rug_rate=0,
        copy_ratio=0,
        positive_sentiment=50,
        cross_platform_lag_minutes=1,
        early_minutes=5,
        x_score=value,
        tg_score=value,
        organic_score=80,
        manipulation_score=10,
        social_risk=risk,
        cross_score=80,
        early_score=80,
        core_social_score=value,
    )


def outcome(hit: bool, multiple: float) -> HistoricalOutcome:
    return HistoricalOutcome(
        baseline_price=1,
        final_price=1,
        peak_price=multiple,
        max_multiple=multiple,
        final_return_pct=0,
        max_drawdown_from_peak_pct=0,
        outcome="win" if hit else "loss",
        hit_20pct=multiple >= 1.2,
        hit_50pct=multiple >= 1.5,
        hit_2x=hit,
    )


def test_walk_forward_threshold_selected_on_train_then_applied_to_test() -> None:
    rows = [
        (45, False),
        (50, False),
        (55, False),
        (65, True),
        (70, True),
        (75, True),
        (80, True),
        (85, True),
        (82, True),
        (48, False),
    ]
    samples = [
        BacktestSample(
            mint=f"{MINT[:-2]}{index:02d}",
            cutoff=NOW + timedelta(days=index),
            channel_id=1,
            features=feature(value),
            outcome=outcome(hit, 2.2 if hit else 1.2),
        )
        for index, (value, hit) in enumerate(rows)
    ]
    report = evaluate_samples(samples, train_fraction=0.7)
    assert report.feature_mode == "causal_core_v4_strict_cutoff"
    assert report.selected_threshold is not None
    assert report.train is not None
    assert report.test is not None
    assert report.train_samples == 7
    assert report.test_samples == 3
    assert report.test.threshold == report.selected_threshold
    assert report.date_start == NOW
    assert report.date_end == NOW + timedelta(days=9)


def test_small_training_set_does_not_overfit_threshold() -> None:
    samples = [
        BacktestSample(MINT, NOW, 1, feature(90), outcome(True, 3.0)),
        BacktestSample(
            MINT[:-1] + "A", NOW + timedelta(days=1), 1, feature(50), outcome(False, 1.1)
        ),
    ]
    report = evaluate_samples(samples, train_fraction=0.5)
    assert report.selected_threshold is None
    assert report.test is None


def test_high_social_risk_blocks_winner_even_with_high_score() -> None:
    samples = [
        BacktestSample(MINT, NOW, 1, feature(90, risk=90), outcome(True, 3.0)),
        BacktestSample(
            MINT[:-1] + "A", NOW + timedelta(days=1), 1, feature(80, risk=20), outcome(True, 2.5)
        ),
        BacktestSample(
            MINT[:-1] + "B", NOW + timedelta(days=2), 1, feature(50), outcome(False, 1.1)
        ),
        BacktestSample(
            MINT[:-1] + "C", NOW + timedelta(days=3), 1, feature(45), outcome(False, 1.1)
        ),
        BacktestSample(
            MINT[:-1] + "D", NOW + timedelta(days=4), 1, feature(42), outcome(False, 1.1)
        ),
        BacktestSample(
            MINT[:-1] + "E", NOW + timedelta(days=5), 1, feature(40), outcome(False, 1.1)
        ),
    ]
    report = evaluate_samples(samples, train_fraction=0.84)
    assert report.train is not None
    assert report.train.true_positives == 1
    assert report.train.false_negatives == 1
