from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.services.social_backtest import (
    BacktestSample,
    HistoricalFeatures,
    HistoricalOutcome,
    build_historical_features,
    build_historical_outcome,
    evaluate_samples,
)


NOW = datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)
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
    events = [event("telegram", 10, source="alpha", text="early gem", metrics={"explicit_call": True})]
    immature_future_leak = call(10, "win")
    matured = call(100, "win")

    without_matured = build_historical_features(
        mint=MINT,
        cutoff=NOW,
        creation_date=NOW - timedelta(hours=2),
        events=events,
        prior_calls_by_channel={1: [immature_future_leak]},
    )
    with_matured = build_historical_features(
        mint=MINT,
        cutoff=NOW,
        creation_date=NOW - timedelta(hours=2),
        events=events,
        prior_calls_by_channel={1: [immature_future_leak, matured]},
    )

    assert without_matured.historical_channels == 0
    assert without_matured.channel_score == 0
    assert with_matured.historical_channels == 1
    assert with_matured.channel_score > 0
    assert with_matured.channel_win_rate == 100
    assert with_matured.tg_score > without_matured.tg_score


def test_missing_x_does_not_receive_clean_x_bonus() -> None:
    features = build_historical_features(
        mint=MINT,
        cutoff=NOW,
        creation_date=NOW - timedelta(hours=1),
        events=[event("telegram", 10, source="alpha", text="early gem", metrics={"explicit_call": True})],
        prior_calls_by_channel={},
    )
    assert features.x_mentions == 0
    assert features.x_score == 0


def test_verified_ratio_counts_unique_authors_not_posts() -> None:
    features = build_historical_features(
        mint=MINT,
        cutoff=NOW,
        creation_date=None,
        events=[
            event("x", 20, source="verified", text="first post", metrics={"verified": True}),
            event("x", 15, source="verified", text="second post", metrics={"verified": True}),
            event("x", 10, source="plain", text="third post", metrics={"verified": False}),
        ],
        prior_calls_by_channel={},
    )
    assert features.x_authors == 2
    assert features.x_verified_ratio == 50
    assert 0 <= features.x_verified_ratio <= 100


def test_missing_channel_history_is_not_treated_as_zero_rug_perfect_safety() -> None:
    no_history = build_historical_features(
        mint=MINT,
        cutoff=NOW,
        creation_date=None,
        events=[event("telegram", 10, source="alpha", text="call", metrics={"explicit_call": True})],
        prior_calls_by_channel={},
    )
    good_history = build_historical_features(
        mint=MINT,
        cutoff=NOW,
        creation_date=None,
        events=[event("telegram", 10, source="alpha", text="call", metrics={"explicit_call": True})],
        prior_calls_by_channel={1: [call(120, "win"), call(200, "win")]},
    )
    assert no_history.historical_channels == 0
    assert good_history.historical_channels == 1
    assert good_history.tg_score > no_history.tg_score


def test_suspicious_x_and_copy_paste_raise_risk() -> None:
    clean = [
        event("x", 20, source="a", text="organic alpha discussion", metrics={"likes": 10}),
        event("x", 15, source="b", text="different token research", metrics={"likes": 8}),
    ]
    spam = [
        event("x", 20, source="a", text="100x gem buy now repeated message", metrics={"suspicious": True}),
        event("x", 15, source="b", text="100x gem buy now repeated message", metrics={"suspicious": True}),
    ]

    clean_features = build_historical_features(
        mint=MINT, cutoff=NOW, creation_date=None, events=clean, prior_calls_by_channel={}
    )
    spam_features = build_historical_features(
        mint=MINT, cutoff=NOW, creation_date=None, events=spam, prior_calls_by_channel={}
    )

    assert spam_features.social_risk > clean_features.social_risk
    assert spam_features.organic_score < clean_features.organic_score


def test_outcome_requires_price_near_cutoff() -> None:
    assert build_historical_outcome(
        cutoff=NOW,
        metrics=[metric(0.75, 1.0), metric(2, 2.0)],
        horizon_hours=72,
        baseline_tolerance_minutes=30,
    ) is None


def test_outcome_marks_2x_without_using_prices_before_cutoff() -> None:
    outcome = build_historical_outcome(
        cutoff=NOW,
        metrics=[metric(-1, 0.1), metric(0.05, 1.0), metric(1, 1.4), metric(6, 2.2), metric(24, 1.8)],
        horizon_hours=72,
    )
    assert outcome is not None
    assert outcome.baseline_price == 1.0
    assert outcome.max_multiple == 2.2
    assert outcome.hit_2x is True


def feature(score: float, risk: float = 20) -> HistoricalFeatures:
    return HistoricalFeatures(
        cutoff=NOW,
        mint=MINT,
        x_mentions=1,
        x_authors=1,
        x_verified_ratio=0,
        x_suspicious_ratio=0,
        x_engagement=1,
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
        x_score=score,
        tg_score=score,
        organic_score=80,
        manipulation_score=10,
        social_risk=risk,
        cross_score=80,
        early_score=80,
        core_social_score=score,
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


def test_walk_forward_threshold_is_selected_on_train_then_applied_to_test() -> None:
    samples = []
    rows = [
        (45, False), (50, False), (55, False), (65, True), (70, True),
        (75, True), (80, True), (85, True), (82, True), (48, False),
    ]
    for index, (social_score, hit) in enumerate(rows):
        samples.append(
            BacktestSample(
                mint=f"{MINT[:-2]}{index:02d}",
                cutoff=NOW + timedelta(days=index),
                channel_id=1,
                features=feature(social_score),
                outcome=outcome(hit, 2.2 if hit else 1.2),
            )
        )

    report = evaluate_samples(samples, train_fraction=0.7)
    assert report.selected_threshold is not None
    assert report.train is not None
    assert report.test is not None
    assert report.train_samples == 7
    assert report.test_samples == 3
    assert report.test.threshold == report.selected_threshold
    assert report.date_start == NOW
    assert report.date_end == NOW + timedelta(days=9)


def test_small_training_set_does_not_overfit_a_threshold() -> None:
    samples = [
        BacktestSample(MINT, NOW, 1, feature(90), outcome(True, 3.0)),
        BacktestSample(MINT[:-1] + "A", NOW + timedelta(days=1), 1, feature(50), outcome(False, 1.1)),
    ]
    report = evaluate_samples(samples, train_fraction=0.5)
    assert report.selected_threshold is None
    assert report.test is None


def test_high_social_risk_blocks_selection_even_with_high_score() -> None:
    samples = [
        BacktestSample(MINT, NOW, 1, feature(90, risk=90), outcome(True, 3.0)),
        BacktestSample(MINT[:-1] + "A", NOW + timedelta(days=1), 1, feature(80, risk=20), outcome(True, 2.5)),
        BacktestSample(MINT[:-1] + "B", NOW + timedelta(days=2), 1, feature(50, risk=20), outcome(False, 1.1)),
        BacktestSample(MINT[:-1] + "C", NOW + timedelta(days=3), 1, feature(45, risk=20), outcome(False, 1.1)),
        BacktestSample(MINT[:-1] + "D", NOW + timedelta(days=4), 1, feature(42, risk=20), outcome(False, 1.1)),
        BacktestSample(MINT[:-1] + "E", NOW + timedelta(days=5), 1, feature(40, risk=20), outcome(False, 1.1)),
    ]
    report = evaluate_samples(samples, train_fraction=0.84)
    assert report.train is not None
    assert report.train.selected <= 1
