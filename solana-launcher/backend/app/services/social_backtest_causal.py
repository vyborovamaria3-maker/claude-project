from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from statistics import mean, median
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analytics import Token, TokenMetric
from app.models.social_intelligence import SocialEvent, TelegramCall, TelegramChannel
from app.services.social_intelligence import classify_call_outcome, score_channel_metrics

POSITIVE_RE = re.compile(
    r"\b(bull|bullish|buy|gem|moon|pump|breakout|alpha|early|strong|ape|send|"
    r"upside|good|great|лонг|покуп|ракета|рост|гем)\b|🚀|🔥|📈|💎",
    re.I,
)
NEGATIVE_RE = re.compile(
    r"\b(rug|scam|dump|sell|exit|dead|avoid|warning|bear|rekt|скам|раг|"
    r"слив|продаж|паден)\b|⚠|📉|☠",
    re.I,
)
PROMO_RE = re.compile(
    r"\b(100x|gem|moon|send it|don't fade|buy now|ca:|contract|promo|marketing|"
    r"signals?|calls?)\b|🚀{3,}|💎{3,}",
    re.I,
)
URL_RE = re.compile(r"https?://\S+", re.I)
SOLANA_RE = re.compile(r"[1-9A-HJ-NP-Za-km-z]{32,44}")
BASELINE_LOOKBACK = timedelta(minutes=90)
FINAL_COVERAGE_TOLERANCE = timedelta(hours=1)
LIMITATIONS = (
    "Qwen/AI outputs are excluded because historical model outputs are not versioned.",
    "Mutable X likes/views/follower/profile metrics are excluded from predictive features.",
    "Historical X risk uses immutable text/promo proxies, not current collector bot metadata.",
    "Backtest Social Score is a causal approximation of the production deterministic core.",
    "Early timing is reported but not used in the core Social Score threshold.",
)


def _utc(value: datetime) -> datetime:
    return (
        value.replace(tzinfo=timezone.utc)
        if value.tzinfo is None
        else value.astimezone(timezone.utc)
    )


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def _source(value: str | None) -> str:
    return (value or "").strip().lower().lstrip("@")


def _text(value: str) -> str:
    normalized = URL_RE.sub(" ", value.lower())
    normalized = SOLANA_RE.sub(" ", normalized)
    return " ".join(
        re.sub(r"[^\w]+", " ", normalized, flags=re.UNICODE).split()
    )[:220]


def _copy_ratio(events: list[SocialEvent]) -> float:
    rows = [_text(event.text or "") for event in events]
    rows = [row for row in rows if len(row) >= 16]
    if not rows:
        return 0.0
    counts: dict[str, int] = defaultdict(int)
    for row in rows:
        counts[row] += 1
    copied = sum(count for count in counts.values() if count > 1)
    return copied / len(rows) * 100.0


def _sentiment(texts: Iterable[str]) -> tuple[float, float, float]:
    positive = negative = neutral = 0
    for value in texts:
        is_positive = bool(POSITIVE_RE.search(value or ""))
        is_negative = bool(NEGATIVE_RE.search(value or ""))
        if is_positive and not is_negative:
            positive += 1
        elif is_negative and not is_positive:
            negative += 1
        else:
            neutral += 1
    total = positive + negative + neutral
    if not total:
        return 0.0, 0.0, 0.0
    return (
        positive / total * 100.0,
        neutral / total * 100.0,
        negative / total * 100.0,
    )


def _window_hours(call: TelegramCall, default: int = 72) -> int:
    meta = call.meta if isinstance(call.meta, dict) else {}
    try:
        value = int(meta.get("evaluation_window_hours", default))
    except (TypeError, ValueError):
        value = default
    return max(6, min(value, 24 * 30))


def _mature(call: TelegramCall, cutoff: datetime) -> bool:
    return bool(
        call.is_explicit_call
        and call.outcome != "pending"
        and _utc(call.called_at) + timedelta(hours=_window_hours(call)) <= cutoff
    )


def _pair_relative_early(minutes: float) -> float:
    if minutes <= 0:
        return 100.0
    return _clamp(100.0 - minutes / 120.0 * 100.0)


def _cross_alignment(x_events: list[SocialEvent], tg_events: list[SocialEvent]) -> float:
    if not x_events or not tg_events:
        return 0.0
    x_times = [_utc(event.occurred_at) for event in x_events]
    tg_times = [_utc(event.occurred_at) for event in tg_events]
    cutoff_seconds = 30 * 60
    lags: list[float] = []
    for left in x_times:
        nearest = min(abs((left - right).total_seconds()) for right in tg_times)
        if nearest <= cutoff_seconds:
            lags.append(nearest)
    for left in tg_times:
        nearest = min(abs((left - right).total_seconds()) for right in x_times)
        if nearest <= cutoff_seconds:
            lags.append(nearest)
    if not lags:
        return 0.0
    matched_share = len(lags) / (len(x_times) + len(tg_times))
    median_lag_minutes = median(lags) / 60.0
    lag_score = _clamp(100.0 - median_lag_minutes / 30.0 * 100.0)
    return _clamp(lag_score * 0.60 + matched_share * 100.0 * 0.40)


@dataclass(frozen=True, slots=True)
class HistoricalFeatures:
    cutoff: datetime
    mint: str
    x_mentions: int
    x_authors: int
    x_verified_ratio: float
    x_suspicious_ratio: float
    x_engagement: float
    tg_mentions: int
    tg_channels: int
    tg_explicit_calls: int
    historical_channels: int
    channel_score: float
    channel_win_rate: float
    channel_rug_rate: float
    copy_ratio: float
    positive_sentiment: float
    cross_platform_lag_minutes: float | None
    early_minutes: float | None
    x_score: float
    tg_score: float
    organic_score: float
    manipulation_score: float
    social_risk: float
    cross_score: float
    early_score: float
    core_social_score: float


@dataclass(frozen=True, slots=True)
class HistoricalOutcome:
    baseline_price: float | None
    final_price: float | None
    peak_price: float | None
    max_multiple: float | None
    final_return_pct: float | None
    max_drawdown_from_peak_pct: float | None
    outcome: str
    hit_20pct: bool
    hit_50pct: bool
    hit_2x: bool


@dataclass(frozen=True, slots=True)
class BacktestSample:
    mint: str
    cutoff: datetime
    channel_id: int
    features: HistoricalFeatures
    outcome: HistoricalOutcome


@dataclass(frozen=True, slots=True)
class ThresholdMetrics:
    threshold: int
    selected: int
    true_positives: int
    false_positives: int
    false_negatives: int
    precision: float
    recall: float
    f1: float
    hit_rate: float
    coverage: float
    lift: float
    median_max_multiple: float | None


@dataclass(frozen=True, slots=True)
class BacktestReport:
    generated_at: datetime
    feature_mode: str
    lookback_hours: int
    horizon_hours: int
    samples: int
    train_samples: int
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
        payload["generated_at"] = self.generated_at.isoformat()
        payload["date_start"] = self.date_start.isoformat() if self.date_start else None
        payload["date_end"] = self.date_end.isoformat() if self.date_end else None
        return payload


def build_historical_features(
    *,
    mint: str,
    cutoff: datetime,
    creation_date: datetime | None,
    events: list[SocialEvent],
    prior_calls_by_channel: dict[int, list[TelegramCall]],
) -> HistoricalFeatures:
    cutoff = _utc(cutoff)
    x_events = [event for event in events if event.platform == "x"]
    tg_events = [event for event in events if event.platform == "telegram"]
    x_authors = {
        _source(event.source_handle)
        for event in x_events
        if event.source_handle
    }

    # Historical mutable engagement/profile data is intentionally excluded.
    x_verified_ratio = 0.0
    x_engagement = 0.0
    promo = sum(1 for event in x_events if PROMO_RE.search(event.text or ""))
    x_suspicious_ratio = promo / len(x_events) * 100.0 if x_events else 0.0

    tg_channels = {
        _source(event.source_handle or event.source_name)
        for event in tg_events
        if event.source_handle or event.source_name
    }
    explicit_calls = sum(
        1
        for event in tg_events
        if bool(
            (event.metrics or {}).get("explicit_call")
            or (event.metrics or {}).get("is_explicit_call")
        )
        or "call" in str(event.event_type or "").lower()
    )

    channel_scores: list[float] = []
    win_rates: list[float] = []
    rug_rates: list[float] = []
    for calls in prior_calls_by_channel.values():
        matured = [call for call in calls if _mature(call, cutoff)]
        if not matured:
            continue
        wins = sum(call.outcome in {"win", "win_then_rug"} for call in matured)
        rugs = sum(call.outcome in {"rug", "win_then_rug"} for call in matured)
        early = sum(
            call.call_market_cap_usd is not None
            and call.call_market_cap_usd <= 50_000
            for call in matured
        )
        rois = [
            float(call.roi_multiple)
            for call in matured
            if call.roi_multiple is not None
        ]
        channel_scores.append(
            score_channel_metrics(
                calls=len(matured),
                evaluated=len(matured),
                wins=wins,
                rugs=rugs,
                early=early,
                avg_roi=mean(rois) if rois else 0.0,
            )
        )
        win_rates.append(wins / len(matured) * 100.0)
        rug_rates.append(rugs / len(matured) * 100.0)

    historical_channels = len(channel_scores)
    channel_score = mean(channel_scores) if channel_scores else 0.0
    win_rate = mean(win_rates) if win_rates else 0.0
    rug_rate = mean(rug_rates) if rug_rates else 0.0
    copy_ratio = _copy_ratio(events)
    positive_sentiment, _, _ = _sentiment(event.text or "" for event in events)
    first_x = min((_utc(event.occurred_at) for event in x_events), default=None)
    first_tg = min((_utc(event.occurred_at) for event in tg_events), default=None)
    first_lag = (
        abs((first_x - first_tg).total_seconds()) / 60.0
        if first_x and first_tg
        else None
    )
    first_social = min(
        (item for item in (first_x, first_tg) if item is not None),
        default=None,
    )
    early_minutes = (
        (first_social - _utc(creation_date)).total_seconds() / 60.0
        if creation_date is not None and first_social is not None
        else None
    )

    author_ratio = len(x_authors) / len(x_events) * 100.0 if x_events else 0.0
    mention_quality = _clamp(math.log10(len(x_events) + 1.0) / 2.0 * 100.0)
    x_score = (
        _clamp(
            (100.0 - x_suspicious_ratio) * 0.40
            + author_ratio * 0.40
            + mention_quality * 0.20
        )
        if x_events
        else 0.0
    )

    channel_quality = (
        _clamp(
            channel_score * 0.55
            + win_rate * 0.25
            + (100.0 - rug_rate) * 0.20
        )
        if historical_channels
        else 0.0
    )
    tg_score = (
        _clamp(
            channel_quality * 0.65
            + _clamp(len(tg_channels) * 7.0) * 0.15
            + _clamp(explicit_calls * 8.0) * 0.20
        )
        if tg_events
        else 0.0
    )

    coordination = _clamp(copy_ratio * 0.80)
    manipulation = _clamp(coordination * 0.55 + x_suspicious_ratio * 0.45)
    source_diversity = _clamp(
        author_ratio * 0.60
        + min(len(tg_channels) * 10.0, 100.0) * 0.40
    )
    organic = _clamp(
        50.0 - manipulation * 0.55 - copy_ratio * 0.15 + source_diversity * 0.35
    )
    channel_risk = rug_rate if historical_channels else 50.0
    social_risk = _clamp(
        manipulation * 0.50
        + channel_risk * 0.20
        + (100.0 - organic) * 0.30
    )
    cross_score = _cross_alignment(x_events, tg_events)
    early_score = (
        _pair_relative_early(early_minutes)
        if early_minutes is not None
        else 0.0
    )

    available_weights = 0.15
    score_sum = organic * 0.15
    if x_events:
        available_weights += 0.36
        score_sum += x_score * 0.36
    if tg_events:
        available_weights += 0.34
        score_sum += tg_score * 0.34
    if x_events and tg_events:
        available_weights += 0.15
        score_sum += cross_score * 0.15
    core_score = _clamp(score_sum / available_weights) if available_weights else 0.0

    return HistoricalFeatures(
        cutoff=cutoff,
        mint=mint,
        x_mentions=len(x_events),
        x_authors=len(x_authors),
        x_verified_ratio=x_verified_ratio,
        x_suspicious_ratio=x_suspicious_ratio,
        x_engagement=x_engagement,
        tg_mentions=len(tg_events),
        tg_channels=len(tg_channels),
        tg_explicit_calls=explicit_calls,
        historical_channels=historical_channels,
        channel_score=channel_score,
        channel_win_rate=win_rate,
        channel_rug_rate=rug_rate,
        copy_ratio=copy_ratio,
        positive_sentiment=positive_sentiment,
        cross_platform_lag_minutes=first_lag,
        early_minutes=early_minutes,
        x_score=x_score,
        tg_score=tg_score,
        organic_score=organic,
        manipulation_score=manipulation,
        social_risk=social_risk,
        cross_score=cross_score,
        early_score=early_score,
        core_social_score=core_score,
    )


def _peak_drawdown(prices: list[float]) -> float | None:
    if not prices:
        return None
    peak = prices[0]
    worst = 0.0
    for price in prices:
        peak = max(peak, price)
        if peak > 0:
            worst = min(worst, (price - peak) / peak * 100.0)
    return worst


def build_historical_outcome(
    *,
    cutoff: datetime,
    metrics: list[TokenMetric],
    horizon_hours: int,
    baseline_price: float | None = None,
    baseline_tolerance_minutes: int = 90,
) -> HistoricalOutcome | None:
    del baseline_price  # Stored legacy call prices may themselves contain look-ahead.
    cutoff = _utc(cutoff)
    end = cutoff + timedelta(hours=horizon_hours)
    tolerance = timedelta(minutes=max(1, baseline_tolerance_minutes))
    valid = [
        metric
        for metric in metrics
        if metric.price_usd is not None and metric.price_usd > 0
    ]
    valid.sort(key=lambda item: _utc(item.timestamp))
    baseline_rows = [
        metric
        for metric in valid
        if cutoff - tolerance <= _utc(metric.timestamp) <= cutoff
    ]
    if not baseline_rows:
        return None
    baseline = float(baseline_rows[-1].price_usd)

    outcome_rows = [
        metric
        for metric in valid
        if cutoff <= _utc(metric.timestamp) <= end
    ]
    if not outcome_rows:
        return None
    final_rows = [
        metric
        for metric in outcome_rows
        if _utc(metric.timestamp) >= end - FINAL_COVERAGE_TOLERANCE
    ]
    if not final_rows:
        return None

    prices = [float(metric.price_usd) for metric in outcome_rows]
    peak = max([baseline, *prices])
    final = float(final_rows[-1].price_usd)
    multiple = peak / baseline
    final_return = (final / baseline - 1.0) * 100.0
    drawdown = _peak_drawdown([baseline, *prices])
    observed_hours = max(
        (_utc(final_rows[-1].timestamp) - cutoff).total_seconds() / 3600.0,
        0.0,
    )
    final_to_peak = final / peak if peak > 0 else None
    outcome = classify_call_outcome(
        roi_multiple=multiple,
        final_to_peak=final_to_peak,
        observed_hours=observed_hours,
        horizon_hours=float(horizon_hours),
    )
    return HistoricalOutcome(
        baseline_price=baseline,
        final_price=final,
        peak_price=peak,
        max_multiple=multiple,
        final_return_pct=final_return,
        max_drawdown_from_peak_pct=drawdown,
        outcome=outcome,
        hit_20pct=multiple >= 1.20,
        hit_50pct=multiple >= 1.50,
        hit_2x=multiple >= 2.0,
    )


def _threshold(
    samples: list[BacktestSample],
    threshold: int,
    baseline_hit_rate: float,
) -> ThresholdMetrics:
    selected = [
        sample
        for sample in samples
        if sample.features.core_social_score >= threshold
        and sample.features.social_risk <= 60
    ]
    positives = [sample for sample in samples if sample.outcome.hit_2x]
    selected_keys = {(sample.mint, sample.cutoff) for sample in selected}
    true_positives = sum(sample.outcome.hit_2x for sample in selected)
    false_positives = len(selected) - true_positives
    false_negatives = sum(
        (sample.mint, sample.cutoff) not in selected_keys
        for sample in positives
    )
    precision = true_positives / len(selected) if selected else 0.0
    recall = true_positives / len(positives) if positives else 0.0
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision + recall
        else 0.0
    )
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
    train_fraction: float = 0.70,
) -> BacktestReport:
    ordered = sorted(samples, key=lambda sample: sample.cutoff)
    now = datetime.now(timezone.utc)
    feature_mode = "causal_core_v4_strict_cutoff"
    if not ordered:
        return BacktestReport(
            now,
            feature_mode,
            lookback_hours,
            horizon_hours,
            0,
            0,
            0,
            None,
            None,
            0.0,
            0.0,
            0.0,
            0.0,
            None,
            None,
            None,
            (),
            (),
            {},
            LIMITATIONS,
        )
    split = (
        max(1, min(len(ordered) - 1, int(len(ordered) * train_fraction)))
        if len(ordered) > 1
        else 1
    )
    train = ordered[:split]
    test = ordered[split:] if split < len(ordered) else []
    baseline = sum(sample.outcome.hit_2x for sample in ordered) / len(ordered)
    train_baseline = (
        sum(sample.outcome.hit_2x for sample in train) / len(train)
        if train
        else 0.0
    )
    test_baseline = (
        sum(sample.outcome.hit_2x for sample in test) / len(test)
        if test
        else 0.0
    )
    sweep = tuple(
        _threshold(train, value, train_baseline)
        for value in range(40, 91, 5)
    )
    eligible = [
        row
        for row in sweep
        if row.selected >= max(3, math.ceil(len(train) * 0.05))
    ]
    best = (
        max(
            eligible,
            key=lambda row: (row.f1, row.precision, row.lift, row.selected),
        )
        if eligible
        else None
    )
    test_result = _threshold(test, best.threshold, test_baseline) if best and test else None

    calibration: list[dict[str, Any]] = []
    for low, high in ((0, 49), (50, 59), (60, 69), (70, 79), (80, 89), (90, 100)):
        bucket = [
            sample
            for sample in ordered
            if low <= sample.features.core_social_score <= high
        ]
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
                "hit_2x_rate": (
                    sum(sample.outcome.hit_2x for sample in bucket) / len(bucket)
                ),
                "median_max_multiple": median(multiples) if multiples else None,
            }
        )

    return BacktestReport(
        generated_at=now,
        feature_mode=feature_mode,
        lookback_hours=lookback_hours,
        horizon_hours=horizon_hours,
        samples=len(ordered),
        train_samples=len(train),
        test_samples=len(test),
        date_start=ordered[0].cutoff,
        date_end=ordered[-1].cutoff,
        x_coverage=sum(sample.features.x_mentions > 0 for sample in ordered) / len(ordered),
        cross_platform_coverage=(
            sum(
                sample.features.x_mentions > 0 and sample.features.tg_mentions > 0
                for sample in ordered
            )
            / len(ordered)
        ),
        historical_channel_coverage=(
            sum(sample.features.historical_channels > 0 for sample in ordered)
            / len(ordered)
        ),
        baseline_hit_rate=baseline,
        selected_threshold=best.threshold if best else None,
        train=best,
        test=test_result,
        threshold_sweep=sweep,
        calibration=tuple(calibration),
        skipped={},
        limitations=LIMITATIONS,
    )


async def run_social_backtest(
    session: AsyncSession,
    *,
    lookback_hours: int = 24,
    horizon_hours: int = 72,
    limit: int = 5000,
    first_call_per_mint: bool = True,
) -> BacktestReport:
    lookback_hours = max(1, min(int(lookback_hours), 24 * 30))
    horizon_hours = max(6, min(int(horizon_hours), 24 * 30))
    rows = list(
        (
            await session.execute(
                select(TelegramCall)
                .where(TelegramCall.is_explicit_call.is_(True))
                .order_by(TelegramCall.called_at.asc())
                .limit(max(1, min(int(limit), 20_000)))
            )
        ).scalars().all()
    )
    if not rows:
        return evaluate_samples(
            [],
            lookback_hours=lookback_hours,
            horizon_hours=horizon_hours,
        )

    mints = sorted({call.mint_address for call in rows})
    tokens = list(
        (
            await session.execute(
                select(Token).where(Token.mint_address.in_(mints))
            )
        ).scalars().all()
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
                    SocialEvent.occurred_at
                    >= min_cutoff - timedelta(hours=lookback_hours),
                    SocialEvent.occurred_at <= max_cutoff,
                )
                .order_by(SocialEvent.occurred_at.asc())
            )
        ).scalars().all()
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
                        TokenMetric.timestamp >= min_cutoff - BASELINE_LOOKBACK,
                        TokenMetric.timestamp
                        <= max_cutoff + timedelta(hours=horizon_hours),
                    )
                    .order_by(TokenMetric.timestamp.asc())
                )
            ).scalars().all()
        )
    metrics_by_token: dict[int, list[TokenMetric]] = defaultdict(list)
    for item in metrics:
        metrics_by_token[item.token_id].append(item)

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
        ).scalars().all()
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
    channel_by_source = {
        key: next(iter(ids))
        for key, ids in source_ids.items()
        if len(ids) == 1
    }

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
        history = {
            channel_id: calls_by_channel.get(channel_id, [])
            for channel_id in channel_ids
        }
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
        )
        if outcome is None:
            skipped["missing_or_censored_price_window"] += 1
            continue
        samples.append(
            BacktestSample(
                call.mint_address,
                cutoff,
                call.channel_id,
                features,
                outcome,
            )
        )
        if first_call_per_mint:
            accepted_mints.add(call.mint_address)

    report = evaluate_samples(
        samples,
        lookback_hours=lookback_hours,
        horizon_hours=horizon_hours,
    )
    return BacktestReport(
        generated_at=report.generated_at,
        feature_mode=report.feature_mode,
        lookback_hours=report.lookback_hours,
        horizon_hours=report.horizon_hours,
        samples=report.samples,
        train_samples=report.train_samples,
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
