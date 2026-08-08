from pathlib import Path

ROOT = Path("solana-launcher")


def replace(path: Path, old: str, new: str, count: int = 1) -> None:
    text = path.read_text()
    actual = text.count(old)
    if actual < count:
        raise SystemExit(f"{path}: expected at least {count} occurrence(s), found {actual}: {old[:120]!r}")
    path.write_text(text.replace(old, new, count))


# Only explicit Telegram calls belong in caller performance/backtests. Plain mint mentions
# remain in the social timeline but do not become scored calls.
telegram = ROOT / "backend/app/services/telegram_intelligence.py"
replace(
    telegram,
    "            if call is None:\n                price, market_cap = await nearest_token_snapshot(session, mint, published_at)",
    "            if call is None and parsed.explicit_call:\n                price, market_cap = await nearest_token_snapshot(session, mint, published_at)",
)

social = ROOT / "backend/app/services/social_intelligence.py"
replace(social, "from datetime import datetime, timezone", "from datetime import datetime, timedelta, timezone")

replace(
    social,
    '''    calls = list((await session.execute(select(TelegramCall).where(TelegramCall.channel_id == channel_id))).scalars().all())
    evaluated_rows = [call for call in calls if call.outcome != "pending"]
    wins = sum(1 for call in evaluated_rows if call.outcome == "win")
    rugs = sum(1 for call in evaluated_rows if call.outcome == "rug")''',
    '''    calls = list(
        (
            await session.execute(
                select(TelegramCall).where(
                    TelegramCall.channel_id == channel_id,
                    TelegramCall.is_explicit_call.is_(True),
                )
            )
        ).scalars().all()
    )
    evaluated_rows = [call for call in calls if call.outcome != "pending"]
    wins = sum(1 for call in evaluated_rows if call.outcome in {"win", "win_then_rug"})
    rugs = sum(1 for call in evaluated_rows if call.outcome in {"rug", "win_then_rug"})''',
)

replace(
    social,
    '''async def evaluate_calls(session: AsyncSession, *, limit: int = 1000) -> dict[str, int]:
    rows = list(
        (
            await session.execute(
                select(TelegramCall).order_by(TelegramCall.called_at.desc()).limit(max(1, min(limit, 5000)))
            )
        ).scalars().all()
    )''',
    '''def classify_call_outcome(
    *,
    roi_multiple: float | None,
    final_to_peak: float | None,
    observed_hours: float,
    min_observation_hours: float = 6.0,
) -> str:
    """Classify only from data observable inside the evaluation window.

    A rug-like collapse is an >=80% drawdown from the observed peak after the minimum
    observation period. This intentionally avoids using the token's current/final status,
    which would leak future information into historical call evaluation.
    """
    rug_like = (
        observed_hours >= min_observation_hours
        and final_to_peak is not None
        and 0 <= final_to_peak <= 0.20
    )
    won = roi_multiple is not None and roi_multiple >= 2.0
    if won and rug_like:
        return "win_then_rug"
    if rug_like:
        return "rug"
    if won:
        return "win"
    if roi_multiple is not None and observed_hours >= min_observation_hours:
        return "loss"
    return "pending"


async def evaluate_calls(
    session: AsyncSession,
    *,
    limit: int = 1000,
    window_hours: int = 72,
) -> dict[str, int]:
    safe_window_hours = max(6, min(int(window_hours), 24 * 30))
    rows = list(
        (
            await session.execute(
                select(TelegramCall)
                .where(TelegramCall.is_explicit_call.is_(True))
                .order_by(TelegramCall.called_at.desc())
                .limit(max(1, min(limit, 5000)))
            )
        ).scalars().all()
    )''',
)

replace(
    social,
    '''        metrics = list(
            (
                await session.execute(
                    select(TokenMetric)
                    .where(TokenMetric.token_id == token.id, TokenMetric.timestamp >= call.called_at)
                    .order_by(TokenMetric.timestamp.asc())
                )
            ).scalars().all()
        )''',
    '''        window_end = _aware(call.called_at) + timedelta(hours=safe_window_hours)
        metrics = list(
            (
                await session.execute(
                    select(TokenMetric)
                    .where(
                        TokenMetric.token_id == token.id,
                        TokenMetric.timestamp >= call.called_at,
                        TokenMetric.timestamp <= window_end,
                    )
                    .order_by(TokenMetric.timestamp.asc())
                )
            ).scalars().all()
        )''',
)

replace(
    social,
    '''        call.roi_multiple = roi
        observed_hours = max((_aware(metrics[-1].timestamp) - _aware(call.called_at)).total_seconds() / 3600.0, 0.0)
        if token.status == TokenStatus.RUGGED.value:
            call.outcome = "rug"
        elif roi is not None and roi >= 2.0:
            call.outcome = "win"
        elif roi is not None and observed_hours >= 6.0:
            call.outcome = "loss"
        else:
            call.outcome = "pending"''',
    '''        call.roi_multiple = roi
        observed_hours = max((_aware(metrics[-1].timestamp) - _aware(call.called_at)).total_seconds() / 3600.0, 0.0)
        final_to_peak = None
        if caps and call.peak_market_cap_usd and call.peak_market_cap_usd > 0:
            final_to_peak = caps[-1] / call.peak_market_cap_usd
        elif prices and call.peak_price_usd and call.peak_price_usd > 0:
            final_to_peak = prices[-1] / call.peak_price_usd
        call.outcome = classify_call_outcome(
            roi_multiple=roi,
            final_to_peak=final_to_peak,
            observed_hours=observed_hours,
        )
        call.meta = {
            **(call.meta or {}),
            "evaluation_window_hours": safe_window_hours,
            "observed_hours": round(observed_hours, 4),
            "final_to_peak": final_to_peak,
        }''',
)
replace(
    social,
    '    return {"evaluated": evaluated, "channels_updated": len(touched_channels)}',
    '    return {"evaluated": evaluated, "channels_updated": len(touched_channels), "window_hours": safe_window_hours}',
)

# Caller leaderboard must ignore historical plain mentions too; preserve both a win and a
# later rug in the aggregate when outcome=win_then_rug.
replace(
    social,
    '''    calls = list((await session.execute(select(TelegramCall).where(TelegramCall.caller_username.is_not(None)))).scalars().all())''',
    '''    calls = list(
        (
            await session.execute(
                select(TelegramCall).where(
                    TelegramCall.caller_username.is_not(None),
                    TelegramCall.is_explicit_call.is_(True),
                )
            )
        ).scalars().all()
    )''',
)
replace(
    social,
    '''        wins = sum(1 for row in evaluated if row.outcome == "win")
        rugs = sum(1 for row in evaluated if row.outcome == "rug")''',
    '''        wins = sum(1 for row in evaluated if row.outcome in {"win", "win_then_rug"})
        rugs = sum(1 for row in evaluated if row.outcome in {"rug", "win_then_rug"})''',
)

# TokenStatus is no longer used by call evaluation; current final status is future leakage.
replace(social, "from app.models.analytics import Token, TokenMetric, TokenStatus", "from app.models.analytics import Token, TokenMetric")

# Expose a bounded evaluation window to admins while keeping a bias-resistant 72h default.
api = ROOT / "backend/app/api/v1/telegram_intelligence.py"
replace(
    api,
    '''async def evaluate(
    limit: int = Query(default=1000, ge=1, le=5000),
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_superuser),
) -> dict:
    return await evaluate_calls(session, limit=limit)''',
    '''async def evaluate(
    limit: int = Query(default=1000, ge=1, le=5000),
    window_hours: int = Query(default=72, ge=6, le=24 * 30),
    session: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_superuser),
) -> dict:
    return await evaluate_calls(session, limit=limit, window_hours=window_hours)''',
)

# Pure regression tests for the new outcome semantics.
tests = ROOT / "backend/tests/test_telegram_intelligence.py"
replace(
    tests,
    "from app.services.social_intelligence import normalize_caller_username, score_channel_metrics",
    "from app.services.social_intelligence import classify_call_outcome, normalize_caller_username, score_channel_metrics",
)
tests.write_text(
    tests.read_text()
    + '''\n\ndef test_call_outcome_is_window_local_and_preserves_win_then_rug() -> None:\n    assert classify_call_outcome(roi_multiple=2.5, final_to_peak=0.8, observed_hours=24) == "win"\n    assert classify_call_outcome(roi_multiple=3.0, final_to_peak=0.1, observed_hours=24) == "win_then_rug"\n    assert classify_call_outcome(roi_multiple=1.2, final_to_peak=0.1, observed_hours=24) == "rug"\n    assert classify_call_outcome(roi_multiple=1.5, final_to_peak=0.9, observed_hours=8) == "loss"\n    assert classify_call_outcome(roi_multiple=1.5, final_to_peak=0.1, observed_hours=2) == "pending"\n'''
)
