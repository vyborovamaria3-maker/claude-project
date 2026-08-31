from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.social_intelligence import TelegramCall, TelegramChannel, TelegramMessage
from app.services.intelligence_backtest import (
    BACKTEST_VERSION,
    _aware,
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
from app.services.social_intelligence import normalize_caller_username


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
            .order_by(func.min(TelegramCall.called_at).asc())
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
                "username": normalize_caller_username(
                    call.caller_username or channel.username or str(channel.telegram_id)
                ),
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


async def run_intelligence_backtest_v2(
    session: AsyncSession,
    *,
    limit: int = 2000,
    decision_delay_minutes: int = 15,
) -> dict[str, Any]:
    """Walk-forward backtest where `limit` means unique first-TG-call mint signals.

    Caller reputation uses only calls whose 24h horizon matured before the current signal. Missing
    stored historical windows are calculated on demand from TokenMetric history instead of silently
    becoming zero reputation. All signal features are cut off at the historical decision time.
    """

    signal_limit = max(1, min(int(limit), 20_000))
    decision_delay_minutes = max(0, min(int(decision_delay_minutes), 120))
    first_signals = await _first_signal_times(session, signal_limit=signal_limit)
    if not first_signals:
        empty = aggregate_backtest_rows([])
        return {
            "version": BACKTEST_VERSION_V2,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "method": "walk_forward_first_tg_call_unique_mints",
            "decision_delay_minutes": decision_delay_minutes,
            "signal_limit": signal_limit,
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
    signals: list[dict[str, Any]] = []
    skipped_no_outcomes = 0
    skipped_duplicate_first_timestamp = 0
    historical_windows_built_on_demand = 0
    signaled_mints: set[str] = set()

    for record in records:
        signal_time = record["called_at"]
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

        mint = str(record["mint"])
        expected_first = first_time_by_mint.get(mint)
        if expected_first is None or signal_time != expected_first or mint in signaled_mints:
            if expected_first is not None and signal_time == expected_first and mint in signaled_mints:
                skipped_duplicate_first_timestamp += 1
            continue
        signaled_mints.add(mint)

        decision_time = signal_time + timedelta(minutes=decision_delay_minutes)
        prior_reputation = historical_caller_reputation(
            history_by_caller.get(record["username"], [])
        )
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
            caller_reputation=float(prior_reputation["score"]),
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

        signals.append(
            {
                "mint": mint,
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
        "version": BACKTEST_VERSION_V2,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "method": "walk_forward_first_tg_call_unique_mints",
        "decision_delay_minutes": decision_delay_minutes,
        "signal_limit": signal_limit,
        "lookahead_guards": {
            "caller_reputation_uses_only_matured_prior_24h_outcomes": True,
            "missing_prior_windows_are_built_on_demand_from_historical_metrics": True,
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
        "unique_mints_seen": len(first_signals),
        "signals_evaluated": len(signals),
        "skipped_no_outcomes": skipped_no_outcomes,
        "skipped_duplicate_first_timestamp": skipped_duplicate_first_timestamp,
        "historical_windows_built_on_demand": historical_windows_built_on_demand,
        "aggregate": aggregate,
        "signals": signals,
    }
