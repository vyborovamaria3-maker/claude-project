from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from statistics import mean, median
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analytics import Token, TokenMetric, Wallet, WalletTrade
from app.models.social_intelligence import SocialEvent, TelegramCall, TelegramChannel, TelegramMessage
from app.services.social_intelligence import normalize_caller_username, score_channel_metrics
from app.services.telegram_outcomes import OUTCOME_WINDOWS_MINUTES, build_outcome_windows
from app.services.telegram_signal_analysis import analyze_coordination_events


BACKTEST_VERSION = 1
LEVELS = ("strong", "consider", "wait", "avoid")


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _clamp(value: float) -> float:
    return max(0.0, min(100.0, value))


def _finite(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed and abs(parsed) != float("inf") else None


def _window(meta: Any, label: str) -> dict[str, Any] | None:
    if not isinstance(meta, dict):
        return None
    windows = meta.get("outcome_windows")
    if not isinstance(windows, dict):
        return None
    row = windows.get(label)
    return row if isinstance(row, dict) else None


def _forwarded(raw: Any) -> bool:
    if not isinstance(raw, dict):
        return False
    return bool(raw.get("forwarded_from") or raw.get("forwarded") or raw.get("is_forwarded"))


def _smart_tags(tags: Any) -> bool:
    if not isinstance(tags, list):
        return False
    normalized = {str(value).strip().lower().replace("-", "_") for value in tags}
    return bool(normalized & {"smart", "smart_money", "smartwallet", "smart_wallet"})


def historical_caller_reputation(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    history = [row for row in rows if isinstance(_window(row.get("meta"), "24h"), dict)]
    evaluated = []
    for row in history:
        window = _window(row.get("meta"), "24h")
        if not window or not window.get("complete"):
            continue
        peak = _finite(window.get("peak_multiple"))
        final_to_peak = _finite(window.get("final_to_peak"))
        if peak is None:
            continue
        evaluated.append((row, peak, final_to_peak))

    calls = len(history)
    wins = sum(peak >= 2.0 for _, peak, _ in evaluated)
    rugs = sum(final_to_peak is not None and final_to_peak <= 0.20 for _, _, final_to_peak in evaluated)
    avg_roi = mean(peak for _, peak, _ in evaluated) if evaluated else 0.0
    early = sum(
        1
        for row in history
        if _finite(row.get("call_market_cap_usd")) is not None
        and float(row["call_market_cap_usd"]) <= 50_000
    )
    reposts = sum(bool(row.get("forwarded")) for row in history)
    outcome_score = score_channel_metrics(
        calls=calls,
        evaluated=len(evaluated),
        wins=wins,
        rugs=rugs,
        early=early,
        avg_roi=avg_roi,
    )
    originality = (1 - reposts / calls) * 100 if calls else 50.0
    experience = min(100.0, calls / 20.0 * 100.0)
    score = _clamp(outcome_score * 0.60 + originality * 0.25 + experience * 0.15)
    return {
        "score": round(score, 1),
        "calls": calls,
        "evaluated": len(evaluated),
        "wins": wins,
        "rugs": rugs,
        "win_rate": round(wins / len(evaluated), 4) if evaluated else None,
        "rug_rate": round(rugs / len(evaluated), 4) if evaluated else None,
        "avg_peak_multiple": round(avg_roi, 4) if evaluated else None,
        "repost_rate": round(reposts / calls, 4) if calls else None,
        "originality_score": round(originality, 1),
    }


def classify_signal_level(
    *,
    independence_score: float | None,
    independent_layers: int,
    caller_reputation: float,
    coordination_risk: float | None,
) -> str:
    independence = independence_score if independence_score is not None else 0.0
    coordination = coordination_risk if coordination_risk is not None else 50.0
    if coordination >= 78 or (independent_layers <= 1 and caller_reputation < 30 and independence < 40):
        return "avoid"
    if independent_layers >= 3 and independence >= 70 and caller_reputation >= 58 and coordination < 45:
        return "strong"
    if independent_layers >= 2 and independence >= 56 and caller_reputation >= 42 and coordination < 62:
        return "consider"
    return "wait"


def aggregate_backtest_rows(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    materialized = list(rows)
    for row in materialized:
        grouped[str(row.get("level") or "wait")].append(row)

    result: dict[str, Any] = {}
    for level in LEVELS:
        level_rows = grouped.get(level, [])
        windows: dict[str, Any] = {}
        for label, _ in OUTCOME_WINDOWS_MINUTES:
            samples = []
            for row in level_rows:
                outcome = (row.get("outcomes") or {}).get(label)
                if not isinstance(outcome, dict) or not outcome.get("complete"):
                    continue
                close = _finite(outcome.get("close_multiple"))
                peak = _finite(outcome.get("peak_multiple"))
                drawdown = _finite(outcome.get("drawdown_from_peak_pct"))
                if close is None or peak is None:
                    continue
                samples.append((close, peak, drawdown))
            if samples:
                closes = [row[0] for row in samples]
                peaks = [row[1] for row in samples]
                drawdowns = [row[2] for row in samples if row[2] is not None]
                windows[label] = {
                    "samples": len(samples),
                    "median_close_multiple": round(median(closes), 4),
                    "median_peak_multiple": round(median(peaks), 4),
                    "positive_close_rate": round(sum(value > 1 for value in closes) / len(closes), 4),
                    "two_x_rate": round(sum(value >= 2 for value in peaks) / len(peaks), 4),
                    "severe_drawdown_rate": round(
                        sum(value >= 80 for value in drawdowns) / len(drawdowns), 4
                    ) if drawdowns else None,
                }
            else:
                windows[label] = {
                    "samples": 0,
                    "median_close_multiple": None,
                    "median_peak_multiple": None,
                    "positive_close_rate": None,
                    "two_x_rate": None,
                    "severe_drawdown_rate": None,
                }
        result[level] = {
            "signals": len(level_rows),
            "windows": windows,
            "median_independence": round(
                median([float(row["independence_score"]) for row in level_rows if row.get("independence_score") is not None]),
                2,
            ) if any(row.get("independence_score") is not None for row in level_rows) else None,
            "median_caller_reputation": round(
                median([float(row.get("caller_reputation") or 0.0) for row in level_rows]),
                2,
            ) if level_rows else None,
        }
    return {
        "signals": len(materialized),
        "levels": result,
    }


def _independence_from_layers(
    tg_score: float | None,
    x_sources: int,
    chain_buyers: int,
) -> tuple[float | None, int, dict[str, float | None]]:
    x_score = _clamp(x_sources / 3.0 * 100.0) if x_sources > 0 else None
    chain_score = _clamp(chain_buyers / 5.0 * 100.0) if chain_buyers > 0 else None
    values = [value for value in (tg_score, x_score, chain_score) if value is not None]
    score = mean(values) if values else None
    independent_layers = sum(value is not None and value >= 55 for value in (tg_score, x_score, chain_score))
    return (
        round(score, 1) if score is not None else None,
        independent_layers,
        {
            "telegram": round(tg_score, 1) if tg_score is not None else None,
            "x": round(x_score, 1) if x_score is not None else None,
            "chain": round(chain_score, 1) if chain_score is not None else None,
        },
    )


async def _decision_outcomes(
    session: AsyncSession,
    *,
    mint: str,
    decision_time: datetime,
) -> dict[str, dict[str, Any]] | None:
    token = (
        await session.execute(select(Token).where(Token.mint_address == mint))
    ).scalar_one_or_none()
    if token is None:
        return None
    start = _aware(decision_time)
    end = start + timedelta(hours=24)
    baseline = (
        await session.execute(
            select(TokenMetric)
            .where(
                TokenMetric.token_id == token.id,
                TokenMetric.timestamp <= start,
                TokenMetric.timestamp >= start - timedelta(minutes=30),
            )
            .order_by(TokenMetric.timestamp.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if baseline is None:
        return None
    metrics = list(
        (
            await session.execute(
                select(TokenMetric)
                .where(
                    TokenMetric.token_id == token.id,
                    TokenMetric.timestamp >= start,
                    TokenMetric.timestamp <= end,
                )
                .order_by(TokenMetric.timestamp.asc())
            )
        ).scalars().all()
    )
    if not metrics:
        return None
    return build_outcome_windows(
        metrics,
        called_at=start,
        call_price_usd=baseline.price_usd,
        call_market_cap_usd=baseline.market_cap,
    )


async def _telegram_coordination_until(
    session: AsyncSession,
    *,
    mint: str,
    start: datetime,
    end: datetime,
) -> dict[str, Any]:
    events = list(
        (
            await session.execute(
                select(SocialEvent)
                .where(
                    SocialEvent.platform == "telegram",
                    SocialEvent.mint_address == mint,
                    SocialEvent.occurred_at >= start,
                    SocialEvent.occurred_at <= end,
                )
                .order_by(SocialEvent.occurred_at.asc())
            )
        ).scalars().all()
    )
    return analyze_coordination_events(
        {
            "source_handle": event.source_handle,
            "text": event.text,
            "occurred_at": event.occurred_at,
            "payload": event.payload,
        }
        for event in events
    )


async def _x_sources_until(
    session: AsyncSession,
    *,
    mint: str,
    start: datetime,
    end: datetime,
) -> int:
    events = list(
        (
            await session.execute(
                select(SocialEvent)
                .where(
                    SocialEvent.platform == "x",
                    SocialEvent.mint_address == mint,
                    SocialEvent.occurred_at >= start,
                    SocialEvent.occurred_at <= end,
                )
            )
        ).scalars().all()
    )
    return len({str(event.source_handle or "").strip().lower() for event in events if event.source_handle})


async def _chain_buyers_until(
    session: AsyncSession,
    *,
    mint: str,
    start: datetime,
    end: datetime,
) -> tuple[int, int]:
    token = (
        await session.execute(select(Token).where(Token.mint_address == mint))
    ).scalar_one_or_none()
    if token is None:
        return 0, 0
    rows = (
        await session.execute(
            select(WalletTrade, Wallet)
            .join(Wallet, Wallet.id == WalletTrade.wallet_id)
            .where(
                WalletTrade.token_id == token.id,
                WalletTrade.buy_timestamp >= start,
                WalletTrade.buy_timestamp <= end,
            )
        )
    ).all()
    unique_wallets = {trade.wallet_id for trade, _ in rows}
    smart_wallets = {trade.wallet_id for trade, wallet in rows if _smart_tags(wallet.tags)}
    return len(unique_wallets), len(smart_wallets)


async def run_intelligence_backtest(
    session: AsyncSession,
    *,
    limit: int = 2000,
    decision_delay_minutes: int = 15,
) -> dict[str, Any]:
    """Walk-forward backtest of the deterministic source-independence levels.

    The signal is anchored to each mint's first explicit Telegram call. The decision is delayed
    by `decision_delay_minutes`; only evidence at or before that decision timestamp is used.
    Caller reputation uses only prior calls whose 24h outcome horizon had already matured before
    the current signal, preventing future-result leakage.
    """

    safe_limit = max(1, min(int(limit), 20_000))
    decision_delay_minutes = max(0, min(int(decision_delay_minutes), 120))
    db_rows = (
        await session.execute(
            select(TelegramCall, TelegramChannel, TelegramMessage)
            .join(TelegramChannel, TelegramChannel.id == TelegramCall.channel_id)
            .join(TelegramMessage, TelegramMessage.id == TelegramCall.message_id)
            .where(TelegramCall.is_explicit_call.is_(True))
            .order_by(TelegramCall.called_at.asc())
            .limit(safe_limit)
        )
    ).all()
    records: list[dict[str, Any]] = []
    for call, channel, message in db_rows:
        username = normalize_caller_username(
            call.caller_username or channel.username or str(channel.telegram_id)
        )
        records.append(
            {
                "id": call.id,
                "username": username,
                "mint": call.mint_address,
                "called_at": _aware(call.called_at),
                "call_market_cap_usd": call.call_market_cap_usd,
                "meta": call.meta or {},
                "forwarded": _forwarded(message.raw),
            }
        )

    matured = sorted(records, key=lambda row: row["called_at"] + timedelta(hours=24))
    matured_index = 0
    history_by_caller: dict[str, list[dict[str, Any]]] = defaultdict(list)
    seen_mints: set[str] = set()
    signals: list[dict[str, Any]] = []
    skipped_no_outcomes = 0

    for record in records:
        signal_time = record["called_at"]
        while matured_index < len(matured):
            candidate = matured[matured_index]
            if candidate["called_at"] + timedelta(hours=24) > signal_time:
                break
            window = _window(candidate.get("meta"), "24h")
            if window and window.get("complete"):
                history_by_caller[candidate["username"]].append(candidate)
            matured_index += 1

        if record["mint"] in seen_mints:
            continue
        seen_mints.add(record["mint"])
        decision_time = signal_time + timedelta(minutes=decision_delay_minutes)
        prior_reputation = historical_caller_reputation(history_by_caller.get(record["username"], []))

        coordination = await _telegram_coordination_until(
            session,
            mint=record["mint"],
            start=signal_time,
            end=decision_time,
        )
        x_sources = await _x_sources_until(
            session,
            mint=record["mint"],
            start=signal_time - timedelta(minutes=30),
            end=decision_time,
        )
        chain_buyers, smart_buyers = await _chain_buyers_until(
            session,
            mint=record["mint"],
            start=signal_time - timedelta(minutes=30),
            end=decision_time,
        )
        tg_score = _finite(coordination.get("source_independence_score")) if coordination.get("sources") else None
        independence_score, independent_layers, layer_scores = _independence_from_layers(
            tg_score,
            x_sources,
            chain_buyers,
        )
        coordination_risk = _finite(coordination.get("coordination_risk"))
        level = classify_signal_level(
            independence_score=independence_score,
            independent_layers=independent_layers,
            caller_reputation=float(prior_reputation["score"]),
            coordination_risk=coordination_risk,
        )
        outcomes = await _decision_outcomes(
            session,
            mint=record["mint"],
            decision_time=decision_time,
        )
        if outcomes is None:
            skipped_no_outcomes += 1
            continue
        signals.append(
            {
                "mint": record["mint"],
                "caller": record["username"],
                "signal_at": signal_time.isoformat(),
                "decision_at": decision_time.isoformat(),
                "decision_delay_minutes": decision_delay_minutes,
                "level": level,
                "caller_reputation": prior_reputation["score"],
                "caller_prior_calls": prior_reputation["calls"],
                "caller_prior_evaluated": prior_reputation["evaluated"],
                "independence_score": independence_score,
                "independent_layers": independent_layers,
                "layer_scores": layer_scores,
                "telegram_sources": int(coordination.get("sources") or 0),
                "telegram_independent_sources": int(coordination.get("independent_sources") or 0),
                "coordination_risk": coordination_risk,
                "x_sources": x_sources,
                "chain_buyers": chain_buyers,
                "smart_tagged_buyers": smart_buyers,
                "outcomes": outcomes,
            }
        )

    aggregate = aggregate_backtest_rows(signals)
    return {
        "version": BACKTEST_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "method": "walk_forward_first_tg_call",
        "decision_delay_minutes": decision_delay_minutes,
        "lookahead_guards": {
            "caller_reputation_uses_only_matured_prior_24h_outcomes": True,
            "signal_features_cut_off_at_decision_time": True,
            "one_signal_per_mint": True,
            "outcomes_measured_from_decision_time": True,
        },
        "limitations": [
            "Historical X independence uses unique ingested X sources; historical bot-risk snapshots are not persisted.",
            "Historical chain independence uses unique WalletTrade buyers; smart-wallet tags are reported separately and are not required for the level score.",
            "Missing TokenMetric history excludes a signal instead of treating its return as zero.",
        ],
        "calls_loaded": len(records),
        "unique_mints_seen": len(seen_mints),
        "signals_evaluated": len(signals),
        "skipped_no_outcomes": skipped_no_outcomes,
        "aggregate": aggregate,
        "signals": signals,
    }
