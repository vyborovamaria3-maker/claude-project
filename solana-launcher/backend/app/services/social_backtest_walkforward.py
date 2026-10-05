from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from statistics import median
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analytics import Token, TokenMetric
from app.models.social_intelligence import SocialEvent, TelegramCall, TelegramChannel
from app.services.social_backtest_causal import (
    LIMITATIONS,
    BacktestSample,
    HistoricalOutcome,
    ThresholdMetrics,
    _source,
    _utc,
    build_historical_features,
)
from app.services.social_intelligence import classify_call_outcome


@dataclass(frozen=True, slots=True)
class BacktestReport:
    generated_at: datetime
    feature_mode: str
    split_mode: str
    lookback_hours: int
    horizon_hours: int
    min_horizon_coverage: float
    samples: int
    train_samples: int
    embargoed_samples: int
    test_samples: int
    date_start: datetime | None
    date_end: datetime | None
    x_coverage: float
    cross_platform_coverage: float
    historical_channel_coverage: float
    baseline_hit_rate: float
    selected_threshold: int | None
    train: ThresholdMetrics | None
    test: ThresholdMetrics | None
    threshold_sweep: tuple[ThresholdMetrics, ...]
    calibration: tuple[dict[str, Any], ...]
    skipped: dict[str, int]
    limitations: tuple[str, ...] = LIMITATIONS

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        for key in ("generated_at", "date_start", "date_end"):
            value = payload[key]
            payload[key] = value.isoformat() if value else None
        return payload


def build_historical_outcome(
    *,
    cutoff: datetime,
    metrics: list[TokenMetric],
    horizon_hours: int,
    baseline_price: float | None = None,
    baseline_tolerance_minutes: int = 75,
    min_horizon_coverage: float = 0.90,
) -> HistoricalOutcome | None:
    cutoff = _utc(cutoff)
    horizon_hours = max(1, int(horizon_hours))
    min_horizon_coverage = max(0.5, min(float(min_horizon_coverage), 1.0))
    end = cutoff + timedelta(hours=horizon_hours)
    usable = [
        metric
        for metric in metrics
        if cutoff <= _utc(metric.timestamp) <= end
        and metric.price_usd is not None
        and metric.price_usd > 0
    ]
    usable.sort(key=lambda item: _utc(item.timestamp))

    baseline = float(baseline_price) if baseline_price is not None and baseline_price > 0 else None
    if baseline is None:
        if not usable:
            return None
        first_delay = (_utc(usable[0].timestamp) - cutoff).total_seconds() / 60.0
        if first_delay > baseline_tolerance_minutes:
            return None
        first_price = usable[0].price_usd
        if first_price is None:
            return None
        baseline = float(first_price)
    if not usable:
        return None

    observed_hours = max((_utc(usable[-1].timestamp) - cutoff).total_seconds() / 3600.0, 0.0)
    if observed_hours < horizon_hours * min_horizon_coverage:
        return None

    prices = [float(metric.price_usd) for metric in usable if metric.price_usd is not None]
    if not prices:
        return None
    peak = max([baseline, *prices])
    final = prices[-1]
    multiple = peak / baseline
    final_to_peak = final / peak if peak > 0 else None
    result = classify_call_outcome(
        roi_multiple=multiple,
        final_to_peak=final_to_peak,
        observed_hours=observed_hours,
    )
    return HistoricalOutcome(
        baseline_price=baseline,
        final_price=final,
        peak_price=peak,
        max_multiple=multiple,
        final_return_pct=(final / baseline - 1.0) * 100.0,
        max_drawdown_from_peak_pct=(final_to_peak - 1.0) * 100.0
        if final_to_peak is not None
        else None,
        outcome=result,
        hit_20pct=multiple >= 1.20,
        hit_50pct=multiple >= 1.50,
        hit_2x=multiple >= 2.0,
    )


def _threshold_metrics(
    samples: list[BacktestSample],
    threshold: int,
    baseline_hit_rate: float,
) -> ThresholdMetrics:
    selected = [
        sample
        for sample in samples
        if sample.features.core_social_score >= threshold and sample.features.social_risk <= 60
    ]
    positives = [sample for sample in samples if sample.outcome.hit_2x]
    selected_keys = {(sample.mint, sample.cutoff) for sample in selected}
    true_positives = sum(sample.outcome.hit_2x for sample in selected)
    false_positives = len(selected) - true_positives
    false_negatives = sum((sample.mint, sample.cutoff) not in selected_keys for sample in positives)
    precision = true_positives / len(selected) if selected else 0.0
    recall = true_positives / len(positives) if positives else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    multiples = [
        sample.outcome.max_multiple
        for sample in selected
        if sample.outcome.max_multiple is not None
    ]
    return ThresholdMetrics(
        threshold=threshold,
        selected=len(selected),
        true_positives=true_positives,
        false_positives=false_positives,
        false_negatives=false_negatives,
        precision=precision,
        recall=recall,
        f1=f1,
        hit_rate=precision,
        coverage=len(selected) / len(samples) if samples else 0.0,
        lift=precision / baseline_hit_rate if baseline_hit_rate > 0 else 0.0,
        median_max_multiple=median(multiples) if multiples else None,
    )


def evaluate_samples(
    samples: list[BacktestSample],
    *,
    lookback_hours: int = 24,
    horizon_hours: int = 72,
    min_horizon_coverage: float = 0.90,
    train_fraction: float = 0.70,
) -> BacktestReport:
    ordered = sorted(samples, key=lambda sample: sample.cutoff)
    generated = datetime.now(UTC)
    if not ordered:
        return BacktestReport(
            generated_at=generated,
            feature_mode="causal_core_v2",
            split_mode="purged_walk_forward",
            lookback_hours=lookback_hours,
            horizon_hours=horizon_hours,
            min_horizon_coverage=min_horizon_coverage,
            samples=0,
            train_samples=0,
            embargoed_samples=0,
            test_samples=0,
            date_start=None,
            date_end=None,
            x_coverage=0.0,
            cross_platform_coverage=0.0,
            historical_channel_coverage=0.0,
            baseline_hit_rate=0.0,
            selected_threshold=None,
            train=None,
            test=None,
            threshold_sweep=(),
            calibration=(),
            skipped={},
        )

    if len(ordered) == 1:
        train_candidates = ordered
        test: list[BacktestSample] = []
    else:
        split = max(1, min(len(ordered) - 1, int(len(ordered) * train_fraction)))
        train_candidates = ordered[:split]
        test = ordered[split:]

    if test:
        test_start = test[0].cutoff
        embargo = timedelta(hours=horizon_hours)
        train = [sample for sample in train_candidates if sample.cutoff + embargo <= test_start]
    else:
        train = train_candidates
    embargoed_samples = len(train_candidates) - len(train)

    baseline = sum(sample.outcome.hit_2x for sample in ordered) / len(ordered)
    train_baseline = sum(sample.outcome.hit_2x for sample in train) / len(train) if train else 0.0
    test_baseline = sum(sample.outcome.hit_2x for sample in test) / len(test) if test else 0.0
    sweep = tuple(
        _threshold_metrics(train, threshold, train_baseline) for threshold in range(40, 91, 5)
    )
    minimum_support = max(3, math.ceil(len(train) * 0.05))
    eligible = [row for row in sweep if row.selected >= minimum_support]
    best = (
        max(
            eligible,
            key=lambda row: (row.f1, row.precision, row.lift, row.selected),
        )
        if eligible
        else None
    )
    test_metrics = (
        _threshold_metrics(test, best.threshold, test_baseline) if best and test else None
    )

    calibration: list[dict[str, Any]] = []
    for low, high in ((0, 49), (50, 59), (60, 69), (70, 79), (80, 89), (90, 100)):
        bucket = [sample for sample in ordered if low <= sample.features.core_social_score <= high]
        if not bucket:
            continue
        multiples = [
            sample.outcome.max_multiple
            for sample in bucket
            if sample.outcome.max_multiple is not None
        ]
        calibration.append(
            {
                "score_min": low,
                "score_max": high,
                "samples": len(bucket),
                "hit_2x_rate": sum(sample.outcome.hit_2x for sample in bucket) / len(bucket),
                "median_max_multiple": median(multiples) if multiples else None,
            }
        )

    return BacktestReport(
        generated_at=generated,
        feature_mode="causal_core_v2",
        split_mode="purged_walk_forward",
        lookback_hours=lookback_hours,
        horizon_hours=horizon_hours,
        min_horizon_coverage=min_horizon_coverage,
        samples=len(ordered),
        train_samples=len(train),
        embargoed_samples=embargoed_samples,
        test_samples=len(test),
        date_start=ordered[0].cutoff,
        date_end=ordered[-1].cutoff,
        x_coverage=sum(sample.features.x_mentions > 0 for sample in ordered) / len(ordered),
        cross_platform_coverage=sum(
            sample.features.x_mentions > 0 and sample.features.tg_mentions > 0 for sample in ordered
        )
        / len(ordered),
        historical_channel_coverage=sum(
            sample.features.historical_channels > 0 for sample in ordered
        )
        / len(ordered),
        baseline_hit_rate=baseline,
        selected_threshold=best.threshold if best else None,
        train=best,
        test=test_metrics,
        threshold_sweep=sweep,
        calibration=tuple(calibration),
        skipped={},
    )


async def run_social_backtest(
    session: AsyncSession,
    *,
    lookback_hours: int = 24,
    horizon_hours: int = 72,
    min_horizon_coverage: float = 0.90,
    limit: int = 5000,
    first_call_per_mint: bool = True,
) -> BacktestReport:
    lookback_hours = max(1, min(int(lookback_hours), 24 * 30))
    horizon_hours = max(6, min(int(horizon_hours), 24 * 30))
    min_horizon_coverage = max(0.5, min(float(min_horizon_coverage), 1.0))

    rows = list(
        (
            await session.execute(
                select(TelegramCall)
                .where(TelegramCall.is_explicit_call.is_(True))
                .order_by(TelegramCall.called_at.asc())
                .limit(max(1, min(int(limit), 20_000)))
            )
        )
        .scalars()
        .all()
    )
    if not rows:
        return evaluate_samples(
            [],
            lookback_hours=lookback_hours,
            horizon_hours=horizon_hours,
            min_horizon_coverage=min_horizon_coverage,
        )

    mints = sorted({call.mint_address for call in rows})
    tokens = list(
        (await session.execute(select(Token).where(Token.mint_address.in_(mints)))).scalars().all()
    )
    token_by_mint = {token.mint_address: token for token in tokens}
    token_ids = [token.id for token in tokens]
    min_cutoff = min(_utc(call.called_at) for call in rows)
    max_cutoff = max(_utc(call.called_at) for call in rows)

    events = list(
        (
            await session.execute(
                select(SocialEvent)
                .where(
                    SocialEvent.mint_address.in_(mints),
                    SocialEvent.occurred_at >= min_cutoff - timedelta(hours=lookback_hours),
                    SocialEvent.occurred_at <= max_cutoff,
                )
                .order_by(SocialEvent.occurred_at.asc())
            )
        )
        .scalars()
        .all()
    )
    events_by_mint: dict[str, list[SocialEvent]] = defaultdict(list)
    for event in events:
        if event.mint_address:
            events_by_mint[event.mint_address].append(event)

    metrics: list[TokenMetric] = []
    if token_ids:
        metrics = list(
            (
                await session.execute(
                    select(TokenMetric)
                    .where(
                        TokenMetric.token_id.in_(token_ids),
                        TokenMetric.timestamp >= min_cutoff,
                        TokenMetric.timestamp <= max_cutoff + timedelta(hours=horizon_hours),
                    )
                    .order_by(TokenMetric.timestamp.asc())
                )
            )
            .scalars()
            .all()
        )
    metrics_by_token: dict[int, list[TokenMetric]] = defaultdict(list)
    for metric in metrics:
        metrics_by_token[metric.token_id].append(metric)

    prior_calls = list(
        (
            await session.execute(
                select(TelegramCall)
                .where(
                    TelegramCall.is_explicit_call.is_(True),
                    TelegramCall.called_at < max_cutoff,
                )
                .order_by(TelegramCall.called_at.asc())
            )
        )
        .scalars()
        .all()
    )
    calls_by_channel: dict[int, list[TelegramCall]] = defaultdict(list)
    for call in prior_calls:
        calls_by_channel[call.channel_id].append(call)

    channels = list((await session.execute(select(TelegramChannel))).scalars().all())
    source_ids: dict[str, set[int]] = defaultdict(set)
    for channel in channels:
        for raw in (channel.username, channel.title, str(channel.telegram_id)):
            key = _source(raw)
            if key:
                source_ids[key].add(channel.id)
    channel_by_source = {key: next(iter(ids)) for key, ids in source_ids.items() if len(ids) == 1}

    samples: list[BacktestSample] = []
    skipped: dict[str, int] = defaultdict(int)
    accepted_mints: set[str] = set()
    for call in rows:
        if first_call_per_mint and call.mint_address in accepted_mints:
            continue
        cutoff = _utc(call.called_at)
        token = token_by_mint.get(call.mint_address)
        if token is None:
            skipped["missing_token"] += 1
            continue
        start = cutoff - timedelta(hours=lookback_hours)
        sample_events = [
            event
            for event in events_by_mint.get(call.mint_address, [])
            if start <= _utc(event.occurred_at) <= cutoff
        ]
        if not sample_events:
            skipped["no_social_events_before_cutoff"] += 1
            continue

        channel_ids = {call.channel_id}
        for event in sample_events:
            if event.platform != "telegram":
                continue
            for raw in (event.source_handle, event.source_name):
                channel_id = channel_by_source.get(_source(raw))
                if channel_id is not None:
                    channel_ids.add(channel_id)
        history = {channel_id: calls_by_channel.get(channel_id, []) for channel_id in channel_ids}
        features = build_historical_features(
            mint=call.mint_address,
            cutoff=cutoff,
            creation_date=token.creation_date,
            events=sample_events,
            prior_calls_by_channel=history,
        )
        outcome = build_historical_outcome(
            cutoff=cutoff,
            metrics=metrics_by_token.get(token.id, []),
            horizon_hours=horizon_hours,
            baseline_price=call.call_price_usd,
            min_horizon_coverage=min_horizon_coverage,
        )
        if outcome is None:
            skipped["insufficient_price_horizon"] += 1
            continue
        samples.append(
            BacktestSample(
                mint=call.mint_address,
                cutoff=cutoff,
                channel_id=call.channel_id,
                features=features,
                outcome=outcome,
            )
        )
        if first_call_per_mint:
            accepted_mints.add(call.mint_address)

    report = evaluate_samples(
        samples,
        lookback_hours=lookback_hours,
        horizon_hours=horizon_hours,
        min_horizon_coverage=min_horizon_coverage,
    )
    return BacktestReport(
        generated_at=report.generated_at,
        feature_mode=report.feature_mode,
        split_mode=report.split_mode,
        lookback_hours=report.lookback_hours,
        horizon_hours=report.horizon_hours,
        min_horizon_coverage=report.min_horizon_coverage,
        samples=report.samples,
        train_samples=report.train_samples,
        embargoed_samples=report.embargoed_samples,
        test_samples=report.test_samples,
        date_start=report.date_start,
        date_end=report.date_end,
        x_coverage=report.x_coverage,
        cross_platform_coverage=report.cross_platform_coverage,
        historical_channel_coverage=report.historical_channel_coverage,
        baseline_hit_rate=report.baseline_hit_rate,
        selected_threshold=report.selected_threshold,
        train=report.train,
        test=report.test,
        threshold_sweep=report.threshold_sweep,
        calibration=report.calibration,
        skipped=dict(skipped),
        limitations=report.limitations,
    )
