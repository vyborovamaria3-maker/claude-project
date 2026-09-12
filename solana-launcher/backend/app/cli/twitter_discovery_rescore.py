from __future__ import annotations

import argparse
import asyncio
import json

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.twitter_discovery_scoring import (
    rescore_discovery_candidates,
    top_discovery_candidates,
)

DEFAULT_STATUSES = "queued,retry,processing,accepted,rejected"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Recalculate Twitter/X discovery scores and frontier priorities."
    )
    parser.add_argument("--limit", type=int, default=1000)
    parser.add_argument("--statuses", default=DEFAULT_STATUSES)
    parser.add_argument("--show-top", type=int, default=20)
    parser.add_argument("--dry-run", action="store_true")
    return parser


def _statuses(value: str) -> tuple[str, ...]:
    statuses = tuple(item.strip().lower() for item in value.split(",") if item.strip())
    return statuses or tuple(DEFAULT_STATUSES.split(","))


async def run(args: argparse.Namespace) -> dict:
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    async with sessionmaker() as session:
        summary = await rescore_discovery_candidates(
            session,
            statuses=_statuses(args.statuses),
            limit=max(1, args.limit),
        )
        top = await top_discovery_candidates(
            session,
            limit=max(1, args.show_top),
        )
        if args.dry_run:
            await session.rollback()
        else:
            await session.commit()
    await engine.dispose()
    return {
        "dry_run": bool(args.dry_run),
        "statuses": list(_statuses(args.statuses)),
        **summary,
        "top": top,
    }


def main() -> None:
    args = build_parser().parse_args()
    print(json.dumps(asyncio.run(run(args)), ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
