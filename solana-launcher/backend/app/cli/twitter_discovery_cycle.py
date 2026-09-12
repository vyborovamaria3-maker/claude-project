from __future__ import annotations

import argparse
import asyncio
import copy
import json

from app.cli.twitter_discovery import build_parser as build_discovery_parser
from app.cli.twitter_discovery import run as run_discovery
from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.twitter_discovery_scoring import rescore_discovery_candidates

DEFAULT_SCORE_STATUSES = ("queued", "retry", "processing", "accepted", "rejected")


def build_parser() -> argparse.ArgumentParser:
    parser = build_discovery_parser()
    parser.description = (
        "Run a self-prioritizing Twitter/X discovery cycle: ingest, rescore, crawl, rescore."
    )
    parser.add_argument("--skip-rescore", action="store_true")
    parser.add_argument("--rescore-limit", type=int, default=1500)
    return parser


async def _rescore_once(*, limit: int, dry_run: bool) -> dict:
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    try:
        async with sessionmaker() as session:
            summary = await rescore_discovery_candidates(
                session,
                statuses=DEFAULT_SCORE_STATUSES,
                limit=max(1, min(int(limit), 5000)),
            )
            if dry_run:
                await session.rollback()
            else:
                await session.commit()
        return summary
    finally:
        await engine.dispose()


async def run(args: argparse.Namespace) -> dict:
    ingest_args = copy.copy(args)
    ingest_args.skip_frontier = True
    ingest_summary = await run_discovery(ingest_args)

    before: dict | None = None
    if not args.skip_rescore:
        before = await _rescore_once(
            limit=args.rescore_limit,
            dry_run=bool(args.dry_run),
        )

    frontier_summary: dict | None = None
    if not args.skip_frontier:
        frontier_args = copy.copy(args)
        frontier_args.skip_seeds = True
        frontier_args.skip_x_search = True
        frontier_args.public_url = []
        frontier_args.skip_frontier = False
        frontier_summary = await run_discovery(frontier_args)

    after: dict | None = None
    if not args.skip_rescore:
        after = await _rescore_once(
            limit=args.rescore_limit,
            dry_run=bool(args.dry_run),
        )

    return {
        "dry_run": bool(args.dry_run),
        "ingest": ingest_summary,
        "rescore_before_frontier": before,
        "frontier": frontier_summary,
        "rescore_after_frontier": after,
    }


def main() -> None:
    args = build_parser().parse_args()
    result = asyncio.run(run(args))
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
