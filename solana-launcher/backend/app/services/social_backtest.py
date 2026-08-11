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
from app.models.social_intelligence import SocialEvent, TelegramCall
from app.services.social_intelligence import classify_call_outcome, score_channel_metrics


POSITIVE_RE = re.compile(
    r"\b(bull|bullish|buy|gem|moon|pump|breakout|alpha|early|strong|ape|send|upside|good|great|лонг|покуп|ракета|рост|гем)\b|🚀|🔥|📈|💎",
    re.IGNORECASE,
)
NEGATIVE_RE = re.compile(
    r"\b(rug|scam|dump|sell|exit|dead|avoid|warning|bear|rekt|скам|раг|слив|продаж|паден)\b|⚠|📉|☠",
    re.IGNORECASE,
)
URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
SOLANA_RE = re.compile(r"[1-9A-HJ-NP-Za-km-z]{32,44}")


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return max(low, min(high, value))


def _metric_number(metrics: dict[str, Any] | None, key: str) -> float:
    if not metrics:
        return 0.0
    try:
        value = float(metrics.get(key) or 0.0)
    except (TypeError, ValueError):
        return 0.0
    return value if math.isfinite(value) else 0.0


def _event_engagement(event: SocialEvent) -> float:
    if event.platform == "x":
        return sum(_metric_number(event.metrics, key) for key in ("likes", "retweets", "replies"))
    return sum(_metric_number(event.metrics, key) for key in ("reactions", "forwards", "replies"))


def _normalise_text(value: str) -> str:
    value = URL_RE.sub(" ", value.lower())
    value = SOLANA_RE.sub(" ", value)
    value = re.sub(r"[^\w]+", " ", value, flags=re.UNICODE)
    return " ".join(value.split())[:220]


def _sentiment(texts: Iterable[str]) -> tuple[float, float, float]:
    pos = neg = neutral = 0
    for text in texts:
        positive = bool(POSITIVE_RE.search(text or ""))
        negative = bool(NEGATIVE_RE.search(text or ""))
        if positive and not negative:
            pos += 1
        elif negative and not positive:
            neg += 1
        else:
            neutral += 1
    total = pos + neg + neutral
    if not total:
        return 0.0, 0.0, 0.0
    return pos / total * 100.0, neutral / total * 100.0, neg / total * 100.0


def _copy_ratio(events: list[SocialEvent]) -> float:
    texts = [_normalise_text(event.text or "") for event in events]
    texts = [text for text in texts if len(text) >= 16]
    if not texts:
        return 0.0
    counts: dict[str, int] = defaultdict(int)
    for text in texts:
        counts[text] += 1
    copied = sum(count for count in counts.values() if count > 1)
    return copied / len(texts) * 100.0


def _safe_evaluation_window_hours(call: TelegramCall, default: int = 72) -> int:
    meta = call.meta if isinstance(call.meta, dict) else {}
    raw = meta.get("evaluation_window_hours", default)
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = default
    return max(6, min(value, 24 * 30))


def _prior_call_is_mature(call: TelegramCall, cutoff: datetime) -> bool:
    if call.outcome == "pending" or not call.is_explicit_call:
        return False
    end = _utc(call.called_at) + timedelta(hours=_safe_evaluation_window_hours(call))
    return end <= cutoff


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
    lookback_hours: int
    horizon_hours: int
    samples: int
    train_samples: int
    test_samples: int
    baseline_hit_rate: float
    selected_threshold: int | None
    train: ThresholdMetrics | None
    test: ThresholdMetrics | None
    threshold_sweep: tuple[ThresholdMetrics, ...]
    calibration: tuple[dict[str, Any], ...]
    skipped: dict[str, int]

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["generated_at"] = self.generated_at.isoformat()
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

    x_authors = {str(event.source_handle or "").lower() for event in x_events if event.source_handle}
    verified = sum(1 for event in x_events if bool((event.metrics or {}).get("verified")))
    suspicious = sum(1 for event in x_events if bool((event.metrics or {}).get("suspicious")))
    x_verified_ratio = verified / len(x_authors) * 100.0 if x_authors else 0.0
    x_suspicious_ratio = suspicious / len(x_events) * 100.0 if x_events else 0.0
    x_engagement = sum(_event_engagement(event) for event in x_events)

    tg_channels = {
        str(event.source_handle or event.source_name or "").lower()
        for event in tg_events
        if event.source_handle or event.source_name
    }
    explicit_calls = sum(
        1
        for event in tg_events
        if bool((event.metrics or {}).get("explicit_call") or (event.metrics or {}).get("is_explicit_call"))
        or "call" in str(event.event_type or "").lower()
    )

    channel_scores: list[float] = []
    win_rates: list[float] = []
    rug_rates: list[float] = []
    for channel_id, calls in prior_calls_by_channel.items():
        matured = [call for call in calls if _prior_call_is_mature(call, cutoff)]
        if not matured:
            continue
        wins = sum(1 for call in matured if call.outcome in {"win", "win_then_rug"})
        rugs = sum(1 for call in matured if call.outcome in {"rug", "win_then_rug"})
        early = sum(1 for call in matured if call.call_market_cap_usd is not None and call.call_market_cap_usd <= 50_000)
        rois = [float(call.roi_multiple) for call in matured if call.roi_multiple is not None]
        avg_roi = mean(rois) if rois else 0.0
        channel_scores.append(
            score_channel_metrics(
                calls=len(matured),
                evaluated=len(matured),
                wins=wins,
                rugs=rugs,
                early=early,
                avg_roi=avg_roi,
            )
        )
        win_rates.append(wins / len(matured) * 100.0)
        rug_rates.append(rugs / len(matured) * 100.0)

    channel_score = mean(channel_scores) if channel_scores else 0.0
    channel_win_rate = mean(win_rates) if win_rates else 0.0
    channel_rug_rate = mean(rug_rates) if rug_rates else 0.0

    copy_ratio = _copy_ratio(events)
    positive_sentiment, _, _ = _sentiment(event.text or "" for event in events)
    first_x = min((_utc(event.occurred_at) for event in x_events), default=None)
    first_tg = min((_utc(event.occurred_at) for event in tg_events), default=None)
    cross_lag = abs((first_x - first_tg).total_seconds()) / 60.0 if first_x and first_tg else None
    first_social = min((value for value in (first_x, first_tg) if value is not None), default=None)
    early_minutes = None
    if creation_date is not None and first_social is not None:
        early_minutes = max(0.0, (first_social - _utc(creation_date)).total_seconds() / 60.0)

    author_ratio = len(x_authors) / len(x_events) * 100.0 if x_events else 0.0
    clean_x = 100.0 - x_suspicious_ratio
    engagement_quality = _clamp(math.log10(x_engagement + 1.0) / 5.0 * 100.0)
    x_score = _clamp(clean_x * 0.45 + author_ratio * 0.30 + engagement_quality * 0.25)
    tg_score = _clamp(
        channel_score * 0.35
        + channel_win_rate * 0.20
        + (100.0 - channel_rug_rate) * 0.20
        + _clamp(len(tg_channels) * 7.0) * 0.10
        + _clamp(explicit_calls * 8.0) * 0.15
    )
    coordination = _clamp(copy_ratio * 0.8)
    manipulation = _clamp(coordination * 0.55 + x_suspicious_ratio * 0.45)
    organic = _clamp(100.0 - manipulation * 0.72 - copy_ratio * 0.18 + author_ratio * 0.22)
    social_risk = _clamp(manipulation * 0.55 + channel_rug_rate * 0.20 + (100.0 - organic) * 0.25)
    cross_score = 0.0 if cross_lag is None else _clamp(100.0 - min(100.0, cross_lag / 3.0))
    early_score = _clamp(70.0 if early_minutes is None else 100.0 - early_minutes / 12.0)
    core_social_score = _clamp(x_score * 0.36 + tg_score * 0.34 + organic * 0.15 + cross_score * 0.15)

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
        channel_score=channel_score,
        channel_win_rate=channel_win_rate,
        channel_rug_rate=channel_rug_rate,
        copy_ratio=copy_ratio,
        positive_sentiment=positive_sentiment,
        cross_platform_lag_minutes=cross_lag,
        early_minutes=early_minutes,
        x_score=x_score,
        tg_score=tg_score,
        organic_score=organic,
        manipulation_score=manipulation,
        social_risk=social_risk,
        cross_score=cross_score,
        early_score=early_score,
        core_social_score=core_social_score,
    )


def build_historical_outcome(
    *,
    cutoff: datetime,
    metrics: list[TokenMetric],
    horizon_hours: int,
    baseline_tolerance_minutes: int = 30,
) -> HistoricalOutcome | None:
    cutoff = _utc(cutoff)
    window_end = cutoff + timedelta(hours=horizon_hours)
    usable = [
        metric
        for metric in metrics
        if cutoff <= _utc(metric.timestamp) <= window_end
        and metric.price_usd is not None
        and metric.price_usd > 0
    ]
    if not usable:
        return None
    usable.sort(key=lambda item: _utc(item.timestamp))
    baseline = usable[0]
    if (_utc(baseline.timestamp) - cutoff).total_seconds() > baseline_tolerance_minutes * 60:
        return None
    prices = [float(metric.price_usd) for metric in usable if metric.price_usd is not None]
    if not prices:
        return None
    baseline_price = prices[0]
    peak_price = max(prices)
    final_price = prices[-1]
    max_multiple = peak_price / baseline_price if baseline_price > 0 else None
    final_return = (final_price / baseline_price - 1.0) * 100.0 if baseline_price > 0 else None
    final_to_peak = final_price / peak_price if peak_price > 0 else None
    observed_hours = max((_utc(usable[-1].timestamp) - cutoff).total_seconds() / 3600.0, 0.0)
    outcome = classify_call_outcome(
        roi_multiple=max_multiple,
        final_to_peak=final_to_peak,
        observed_hours=observed_hours,
    )
    return HistoricalOutcome(
        baseline_price=baseline_price,
        final_price=final_price,
        peak_price=peak_price,
        max_multiple=max_multiple,
        final_return_pct=final_return,
        max_drawdown_from_peak_pct=(final_to_peak - 1.0) * 100.0 if final_to_peak is not None else None,
        outcome=outcome,
        hit_20pct=bool(max_multiple is not None and max_multiple >= 1.20),
        hit_50pct=bool(max_multiple is not None and max_multiple >= 1.50),
        hit_2x=bool(max_multiple is not None and max_multiple >= 2.0),
    )


def _threshold_metrics(samples: list[BacktestSample], threshold: int, baseline_hit_rate: float) -> ThresholdMetrics:
    selected = [sample for sample in samples if sample.features.core_social_score >= threshold and sample.features.social_risk <= 60]
    positives = [sample for sample in samples if sample.outcome.hit_2x]
    true_positives = sum(1 for sample in selected if sample.outcome.hit_2x)
    false_positives = len(selected) - true_positives
    false_negatives = sum(1 for sample in positives if sample not in selected)
    precision = true_positives / len(selected) if selected else 0.0
    recall = true_positives / len(positives) if positives else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    multiples = [sample.outcome.max_multiple for sample in selected if sample.outcome.max_multiple is not None]
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


def evaluate_samples(samples: list[BacktestSample], *, train_fraction: float = 0.70) -> BacktestReport:
    ordered = sorted(samples, key=lambda sample: sample.cutoff)
    if not ordered:
        return BacktestReport(
            generated_at=datetime.now(timezone.utc), lookback_hours=24, horizon_hours=72,
            samples=0, train_samples=0, test_samples=0, baseline_hit_rate=0.0,
            selected_threshold=None, train=None, test=None, threshold_sweep=(), calibration=(), skipped={},
        )
    split = max(1, min(len(ordered) - 1, int(len(ordered) * train_fraction))) if len(ordered) > 1 else 1
    train = ordered[:split]
    test = ordered[split:] if split < len(ordered) else ordered
    baseline = sum(sample.outcome.hit_2x for sample in ordered) / len(ordered)
    train_baseline = sum(sample.outcome.hit_2x for sample in train) / len(train) if train else 0.0
    test_baseline = sum(sample.outcome.hit_2x for sample in test) / len(test) if test else 0.0
    sweep = tuple(_threshold_metrics(train, threshold, train_baseline) for threshold in range(40, 91, 5))
    eligible = [row for row in sweep if row.selected >= max(3, int(len(train) * 0.05))]
    best = max(eligible or list(sweep), key=lambda row: (row.f1, row.precision, row.lift, row.selected)) if sweep else None
    test_metrics = _threshold_metrics(test, best.threshold, test_baseline) if best and test else None

    calibration: list[dict[str, Any]] = []
    for low, high in ((0, 49), (50, 59), (60, 69), (70, 79), (80, 89), (90, 100)):
        bucket = [sample for sample in ordered if low <= sample.features.core_social_score <= high]
        if not bucket:
            continue
        hits = sum(sample.outcome.hit_2x for sample in bucket)
        calibration.append({
            "score_min": low,
            "score_max": high,
            "samples": len(bucket),
            "hit_2x_rate": hits / len(bucket),
            "median_max_multiple": median(
                sample.outcome.max_multiple for sample in bucket if sample.outcome.max_multiple is not None
            ),
        })

    return BacktestReport(
        generated_at=datetime.now(timezone.utc),
        lookback_hours=24,
        horizon_hours=72,
        samples=len(ordered),
        train_samples=len(train),
        test_samples=len(test),
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
    limit: int = 5000,
    first_call_per_mint: bool = True,
) -> BacktestReport:
    lookback_hours = max(1, min(int(lookback_hours), 24 * 30))
    horizon_hours = max(6, min(int(horizon_hours), 24 * 30))
    rows = list((await session.execute(
        select(TelegramCall)
        .where(TelegramCall.is_explicit_call.is_(True))
        .order_by(TelegramCall.called_at.asc())
        .limit(max(1, min(int(limit), 20_000)))
    )).scalars().all())

    candidates: list[TelegramCall] = []
    seen_mints: set[str] = set()
    for call in rows:
        if first_call_per_mint and call.mint_address in seen_mints:
            continue
        seen_mints.add(call.mint_address)
        candidates.append(call)
    if not candidates:
        report = evaluate_samples([])
        return BacktestReport(**{**asdict(report), "lookback_hours": lookback_hours, "horizon_hours": horizon_hours})

    mints = sorted({call.mint_address for call in candidates})
    tokens = list((await session.execute(select(Token).where(Token.mint_address.in_(mints)))).scalars().all())
    token_by_mint = {token.mint_address: token for token in tokens}
    token_ids = [token.id for token in tokens]
    min_cutoff = min(_utc(call.called_at) for call in candidates)
    max_cutoff = max(_utc(call.called_at) for call in candidates)

    events = list((await session.execute(
        select(SocialEvent)
        .where(
            SocialEvent.mint_address.in_(mints),
            SocialEvent.occurred_at >= min_cutoff - timedelta(hours=lookback_hours),
            SocialEvent.occurred_at <= max_cutoff,
        )
        .order_by(SocialEvent.occurred_at.asc())
    )).scalars().all())
    events_by_mint: dict[str, list[SocialEvent]] = defaultdict(list)
    for event in events:
        if event.mint_address:
            events_by_mint[event.mint_address].append(event)

    metrics = []
    if token_ids:
        metrics = list((await session.execute(
            select(TokenMetric)
            .where(
                TokenMetric.token_id.in_(token_ids),
                TokenMetric.timestamp >= min_cutoff,
                TokenMetric.timestamp <= max_cutoff + timedelta(hours=horizon_hours),
            )
            .order_by(TokenMetric.timestamp.asc())
        )).scalars().all())
    metrics_by_token: dict[int, list[TokenMetric]] = defaultdict(list)
    for item in metrics:
        metrics_by_token[item.token_id].append(item)

    history_rows = list((await session.execute(
        select(TelegramCall)
        .where(TelegramCall.is_explicit_call.is_(True), TelegramCall.called_at < max_cutoff)
        .order_by(TelegramCall.called_at.asc())
    )).scalars().all())
    calls_by_channel: dict[int, list[TelegramCall]] = defaultdict(list)
    for call in history_rows:
        calls_by_channel[call.channel_id].append(call)

    samples: list[BacktestSample] = []
    skipped: dict[str, int] = defaultdict(int)
    for call in candidates:
        cutoff = _utc(call.called_at)
        token = token_by_mint.get(call.mint_address)
        if token is None:
            skipped["missing_token"] += 1
            continue
        lookback_start = cutoff - timedelta(hours=lookback_hours)
        sample_events = [
            event for event in events_by_mint.get(call.mint_address, [])
            if lookback_start <= _utc(event.occurred_at) <= cutoff
        ]
        if not sample_events:
            skipped["no_social_events_before_cutoff"] += 1
            continue
        tg_channel_ids = {call.channel_id}
        prior_by_channel = {channel_id: calls_by_channel.get(channel_id, []) for channel_id in tg_channel_ids}
        features = build_historical_features(
            mint=call.mint_address,
            cutoff=cutoff,
            creation_date=token.creation_date,
            events=sample_events,
            prior_calls_by_channel=prior_by_channel,
        )
        outcome = build_historical_outcome(
            cutoff=cutoff,
            metrics=metrics_by_token.get(token.id, []),
            horizon_hours=horizon_hours,
        )
        if outcome is None:
            skipped["missing_price_window"] += 1
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

    report = evaluate_samples(samples)
    return BacktestReport(
        generated_at=report.generated_at,
        lookback_hours=lookback_hours,
        horizon_hours=horizon_hours,
        samples=report.samples,
        train_samples=report.train_samples,
        test_samples=report.test_samples,
        baseline_hit_rate=report.baseline_hit_rate,
        selected_threshold=report.selected_threshold,
        train=report.train,
        test=report.test,
        threshold_sweep=report.threshold_sweep,
        calibration=report.calibration,
        skipped=dict(skipped),
    )
