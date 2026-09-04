from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from statistics import median
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.social_intelligence import TelegramCall, TelegramChannel, TelegramMessage
from app.services.intelligence_backtest import (
    BACKTEST_BASELINE_MAX_AGE_MINUTES,
    BACKTEST_VERSION,
    _aware,
    _caller_name,
    _chain_buyers_until,
    _decision_outcomes,
    _finite,
    _forwarded,
    _independence_from_layers,
    _telegram_coordination_until,
    _window,
    _x_sources_until,
    aggregate_backtest_rows,
    classify_signal_level,
    historical_caller_reputation,
)

BACKTEST_VERSION_V2 = BACKTEST_VERSION + 1


async def _first_signal_times(
    session: AsyncSession,
    *,
    signal_limit: int,
) -> list[tuple[str, datetime]]:
    rows = (
        await session.execute(
            select(
                TelegramCall.mint_address,
                func.min(TelegramCall.called_at).label("first_at"),
            )
            .where(TelegramCall.is_explicit_call.is_(True))
            .group_by(TelegramCall.mint_address)
            .order_by(func.min(TelegramCall.called_at).asc(), TelegramCall.mint_address.asc())
            .limit(signal_limit)
        )
    ).all()
    return [
        (str(mint), _aware(first_at))
        for mint, first_at in rows
        if mint and isinstance(first_at, datetime)
    ]


async def _history_records_until(
    session: AsyncSession,
    *,
    cutoff: datetime,
) -> list[dict[str, Any]]:
    db_rows = (
        await session.execute(
            select(TelegramCall, TelegramChannel, TelegramMessage)
            .join(TelegramChannel, TelegramChannel.id == TelegramCall.channel_id)
            .join(TelegramMessage, TelegramMessage.id == TelegramCall.message_id)
            .where(
                TelegramCall.is_explicit_call.is_(True),
                TelegramCall.called_at <= cutoff,
            )
            .order_by(TelegramCall.called_at.asc(), TelegramCall.id.asc())
        )
    ).all()
    records: list[dict[str, Any]] = []
    for call, channel, message in db_rows:
        records.append(
            {
                "id": call.id,
                "username": _caller_name(call, channel),
                "mint": call.mint_address,
                "called_at": _aware(call.called_at),
                "call_market_cap_usd": call.call_market_cap_usd,
                "meta": dict(call.meta or {}),
                "forwarded": _forwarded(message.raw),
            }
        )
    return records


async def _ensure_matured_24h_window(
    session: AsyncSession,
    record: dict[str, Any],
) -> bool:
    existing = _window(record.get("meta"), "24h")
    if existing and existing.get("complete"):
        return True

    outcomes = await _decision_outcomes(
        session,
        mint=str(record["mint"]),
        decision_time=_aware(record["called_at"]),
    )
    if not outcomes:
        return False
    window = outcomes.get("24h")
    if not isinstance(window, dict) or not window.get("complete"):
        return False
    meta = dict(record.get("meta") or {})
    meta["outcome_windows"] = outcomes
    record["meta"] = meta
    return True


def _tied_caller_reputation(
    tied_records: list[dict[str, Any]],
    history_by_caller: dict[str, list[dict[str, Any]]],
) -> tuple[float | None, dict[str, dict[str, Any]]]:
    profiles: dict[str, dict[str, Any]] = {}
    for username in sorted({str(row["username"]) for row in tied_records}):
        profiles[username] = historical_caller_reputation(history_by_caller.get(username, []))
    known_scores = [
        float(profile["score"]) for profile in profiles.values() if profile.get("score") is not None
    ]
    return (round(median(known_scores), 1) if known_scores else None), profiles


async def run_intelligence_backtest_v2(
    session: AsyncSession,
    *,
    limit: int = 2000,
    decision_delay_minutes: int = 15,
) -> dict[str, Any]:
    """Leakage-aware walk-forward backtest over unique first-Telegram-call mint signals.

    Caller reputation uses only calls whose 24h horizon matured before the signal. If several
    channels share the exact earliest timestamp, their known prior reputations are aggregated by
    median instead of choosing whichever database row happens to sort first. Unknown reputation
    remains null and cannot by itself turn a signal bearish.
    """

    signal_limit = max(1, min(int(limit), 20_000))
    decision_delay_minutes = max(0, min(int(decision_delay_minutes), 120))
    first_signals = await _first_signal_times(session, signal_limit=signal_limit)
    if not first_signals:
        empty = aggregate_backtest_rows([])
        return {
            "version": BACKTEST_VERSION_V2,
            "generated_at": datetime.now(UTC).isoformat(),
            "method": "walk_forward_first_tg_call_unique_mints",
            "decision_delay_minutes": decision_delay_minutes,
            "signal_limit": signal_limit,
            "baseline_max_age_minutes": BACKTEST_BASELINE_MAX_AGE_MINUTES,
            "calls_loaded": 0,
            "unique_mints_seen": 0,
            "signals_evaluated": 0,
            "skipped_no_outcomes": 0,
            "aggregate": empty,
            "signals": [],
        }

    first_time_by_mint = {mint: called_at for mint, called_at in first_signals}
    cutoff = max(first_time_by_mint.values())
    records = await _history_records_until(session, cutoff=cutoff)
    matured = sorted(records, key=lambda row: row["called_at"] + timedelta(hours=24))
    matured_index = 0
    history_by_caller: dict[str, list[dict[str, Any]]] = defaultdict(list)
    records_by_first_signal: dict[tuple[str, datetime], list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        mint = str(record["mint"])
        first_at = first_time_by_mint.get(mint)
        if first_at is not None and record["called_at"] == first_at:
            records_by_first_signal[(mint, first_at)].append(record)

    signals: list[dict[str, Any]] = []
    skipped_no_outcomes = 0
    historical_windows_built_on_demand = 0
    tied_first_signals = 0

    for mint, signal_time in first_signals:
        while matured_index < len(matured):
            candidate = matured[matured_index]
            if candidate["called_at"] + timedelta(hours=24) > signal_time:
                break
            existing = _window(candidate.get("meta"), "24h")
            had_complete = bool(existing and existing.get("complete"))
            if await _ensure_matured_24h_window(session, candidate):
                history_by_caller[candidate["username"]].append(candidate)
                if not had_complete:
                    historical_windows_built_on_demand += 1
            matured_index += 1

        tied_records = records_by_first_signal.get((mint, signal_time), [])
        if not tied_records:
            continue
        if len(tied_records) > 1:
            tied_first_signals += 1
        first_callers = sorted({str(row["username"]) for row in tied_records})
        prior_score, caller_profiles = _tied_caller_reputation(tied_records, history_by_caller)
        decision_time = signal_time + timedelta(minutes=decision_delay_minutes)

        coordination = await _telegram_coordination_until(
            session,
            mint=mint,
            start=signal_time,
            end=decision_time,
        )
        x_sources = await _x_sources_until(
            session,
            mint=mint,
            start=signal_time - timedelta(minutes=30),
            end=decision_time,
        )
        chain_buyers, smart_buyers = await _chain_buyers_until(
            session,
            mint=mint,
            start=signal_time - timedelta(minutes=30),
            end=decision_time,
        )
        tg_score = (
            _finite(coordination.get("source_independence_score"))
            if coordination.get("sources")
            else None
        )
        independence_score, independent_layers, layer_scores = _independence_from_layers(
            tg_score,
            x_sources,
            chain_buyers,
        )
        coordination_risk = _finite(coordination.get("coordination_risk"))
        level = classify_signal_level(
            independence_score=independence_score,
            independent_layers=independent_layers,
            caller_reputation=prior_score,
            coordination_risk=coordination_risk,
        )
        outcomes = await _decision_outcomes(
            session,
            mint=mint,
            decision_time=decision_time,
        )
        if outcomes is None:
            skipped_no_outcomes += 1
            continue

        prior_calls = sum(int(profile.get("calls") or 0) for profile in caller_profiles.values())
        prior_evaluated = sum(
            int(profile.get("evaluated") or 0) for profile in caller_profiles.values()
        )
        signals.append(
            {
                "mint": mint,
                "caller": first_callers[0] if len(first_callers) == 1 else None,
                "first_callers": first_callers,
                "tied_first_callers": len(first_callers),
                "signal_at": signal_time.isoformat(),
                "decision_at": decision_time.isoformat(),
                "decision_delay_minutes": decision_delay_minutes,
                "level": level,
                "caller_reputation": prior_score,
                "caller_prior_calls": prior_calls,
                "caller_prior_evaluated": prior_evaluated,
                "caller_profiles_at_signal": caller_profiles,
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
        "version": BACKTEST_VERSION_V2,
        "generated_at": datetime.now(UTC).isoformat(),
        "method": "walk_forward_first_tg_call_unique_mints",
        "decision_delay_minutes": decision_delay_minutes,
        "signal_limit": signal_limit,
        "baseline_max_age_minutes": BACKTEST_BASELINE_MAX_AGE_MINUTES,
        "lookahead_guards": {
            "caller_reputation_uses_only_matured_prior_24h_outcomes": True,
            "missing_prior_windows_are_built_on_demand_from_historical_metrics": True,
            "signal_features_cut_off_at_decision_time": True,
            "one_signal_per_mint": True,
            "tied_first_callers_are_aggregated_not_arbitrarily_selected": True,
            "unknown_caller_history_is_not_zero": True,
            "outcomes_measured_from_decision_time": True,
            "decision_baseline_has_max_age": True,
        },
        "limitations": [
            "Historical X independence uses unique ingested X sources; "
            "historical bot-risk snapshots are not persisted.",
            "Historical chain independence uses unique WalletTrade buyers; "
            "smart-wallet tags are reported separately and are not required for the level score.",
            "Missing TokenMetric history or a decision baseline older than "
            f"{BACKTEST_BASELINE_MAX_AGE_MINUTES} minutes excludes a signal "
            "instead of treating its return as zero.",
        ],
        "calls_loaded": len(records),
        "unique_mints_seen": len(first_signals),
        "signals_evaluated": len(signals),
        "skipped_no_outcomes": skipped_no_outcomes,
        "tied_first_signals": tied_first_signals,
        "historical_windows_built_on_demand": historical_windows_built_on_demand,
        "aggregate": aggregate,
        "signals": signals,
    }
