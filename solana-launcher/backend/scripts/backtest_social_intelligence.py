from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.social_backtest import run_social_backtest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Leakage-safe walk-forward backtest for Social Intelligence."
    )
    parser.add_argument("--lookback-hours", type=int, default=24)
    parser.add_argument("--horizon-hours", type=int, default=72)
    parser.add_argument("--limit", type=int, default=5000)
    parser.add_argument(
        "--all-calls",
        action="store_true",
        help="Include repeated calls for the same mint. Default uses first explicit call per mint.",
    )
    parser.add_argument("--output", type=Path, default=None)
    return parser.parse_args()


async def main() -> int:
    args = parse_args()
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    try:
        async with sessionmaker() as session:
            report = await run_social_backtest(
                session,
                lookback_hours=args.lookback_hours,
                horizon_hours=args.horizon_hours,
                limit=args.limit,
                first_call_per_mint=not args.all_calls,
            )
        payload = report.to_dict()
        text = json.dumps(payload, ensure_ascii=False, indent=2, default=str)
        if args.output is not None:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(text + "\n", encoding="utf-8")
        print(text)
        if report.samples == 0:
            return 2
        return 0
    finally:
        await engine.dispose()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
