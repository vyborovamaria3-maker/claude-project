from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.intelligence_backtest_v2 import run_intelligence_backtest_v2
from app.services.telegram_outcomes import evaluate_outcome_windows


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Run a walk-forward backtest of Telegram caller reputation + X/TG/on-chain "
            "source independence using only evidence available at each historical decision time."
        )
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=2000,
        help="maximum unique mint signals (first explicit Telegram call per mint)",
    )
    parser.add_argument(
        "--decision-delay",
        type=int,
        default=15,
        help="minutes after the first Telegram call before the historical decision is evaluated",
    )
    parser.add_argument(
        "--output",
        default="data/backtests/intelligence-backtest.json",
        help="JSON report path",
    )
    parser.add_argument(
        "--skip-window-refresh",
        action="store_true",
        help=(
            "skip best-effort stored outcome refresh; missing prior windows are still built "
            "on demand"
        ),
    )
    return parser


async def _run(args: argparse.Namespace) -> dict:
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    try:
        window_refresh = None
        if not args.skip_window_refresh:
            async with sessionmaker() as session:
                window_refresh = await evaluate_outcome_windows(
                    session,
                    limit=max(1, min(int(args.limit), 20_000)),
                    commit=True,
                    order="asc",
                )
        async with sessionmaker() as session:
            report = await run_intelligence_backtest_v2(
                session,
                limit=args.limit,
                decision_delay_minutes=args.decision_delay,
            )
        report["outcome_window_refresh"] = window_refresh
        return report
    finally:
        await engine.dispose()


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be positive")
    if args.decision_delay < 0 or args.decision_delay > 120:
        parser.error("--decision-delay must be between 0 and 120 minutes")

    report = asyncio.run(_run(args))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    summary = {
        "method": report.get("method"),
        "signal_limit": report.get("signal_limit"),
        "calls_loaded": report.get("calls_loaded"),
        "unique_mints_seen": report.get("unique_mints_seen"),
        "signals_evaluated": report.get("signals_evaluated"),
        "skipped_no_outcomes": report.get("skipped_no_outcomes"),
        "historical_windows_built_on_demand": report.get("historical_windows_built_on_demand"),
        "levels": (report.get("aggregate") or {}).get("levels"),
        "output": str(output),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
