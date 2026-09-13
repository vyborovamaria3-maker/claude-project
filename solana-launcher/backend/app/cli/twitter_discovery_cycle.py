from __future__ import annotations

import argparse
import asyncio
import copy
import json
import sys

from app.cli.twitter_discovery import build_parser as build_discovery_parser
from app.cli.twitter_discovery import run as run_discovery
from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.twitter_crawler_runs import (
    try_finish_twitter_crawler_run,
    try_heartbeat_twitter_crawler_run,
    try_start_twitter_crawler_run,
)
from app.services.twitter_crawler_settings import (
    apply_twitter_crawler_config,
    explicit_cli_flags,
    load_twitter_crawler_config,
)
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


async def run(args: argparse.Namespace, *, run_id: int | None = None) -> dict:
    await try_heartbeat_twitter_crawler_run(run_id, phase="ingest")
    ingest_args = copy.copy(args)
    ingest_args.skip_frontier = True
    ingest_summary = await run_discovery(ingest_args)

    before: dict | None = None
    if not args.skip_rescore:
        await try_heartbeat_twitter_crawler_run(
            run_id,
            phase="rescore_before_frontier",
            summary={"ingest": ingest_summary},
        )
        before = await _rescore_once(
            limit=args.rescore_limit,
            dry_run=bool(args.dry_run),
        )

    frontier_summary: dict | None = None
    if not args.skip_frontier:
        await try_heartbeat_twitter_crawler_run(
            run_id,
            phase="frontier",
            summary={"ingest": ingest_summary, "rescore_before_frontier": before},
        )
        frontier_args = copy.copy(args)
        frontier_args.skip_seeds = True
        frontier_args.skip_x_search = True
        frontier_args.public_url = []
        frontier_args.skip_frontier = False
        frontier_summary = await run_discovery(frontier_args)

    after: dict | None = None
    if not args.skip_rescore:
        await try_heartbeat_twitter_crawler_run(
            run_id,
            phase="rescore_after_frontier",
            summary={
                "ingest": ingest_summary,
                "rescore_before_frontier": before,
                "frontier": frontier_summary,
            },
        )
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


async def run_tracked(args: argparse.Namespace) -> dict:
    run_id = await try_start_twitter_crawler_run(
        "twitter_discovery_cycle",
        meta={
            "dry_run": bool(args.dry_run),
            "skip_frontier": bool(args.skip_frontier),
            "skip_rescore": bool(args.skip_rescore),
            "query_limit": int(args.query_limit),
            "process_limit": int(args.process_limit),
            "batch_size": int(args.batch_size),
            "max_depth": int(args.max_depth),
            "min_relevance": float(args.min_relevance),
            "network_mode": str(args.network_mode),
            "network_limit": int(args.network_limit),
            "lease_seconds": int(args.lease_seconds),
            "rescore_limit": int(args.rescore_limit),
        },
    )
    try:
        result = await run(args, run_id=run_id)
    except Exception as exc:
        await try_finish_twitter_crawler_run(
            run_id,
            status="failed",
            phase="failed",
            error=f"{type(exc).__name__}: {exc}",
        )
        raise

    await try_finish_twitter_crawler_run(
        run_id,
        status="success",
        phase="complete",
        summary=result,
    )
    return result


async def run_configured(args: argparse.Namespace, argv: list[str]) -> dict:
    config = await load_twitter_crawler_config()
    if config is not None:
        apply_twitter_crawler_config(
            args,
            config,
            explicit_flags=explicit_cli_flags(argv),
        )
        if not config.enabled:
            run_id = await try_start_twitter_crawler_run(
                "twitter_discovery_cycle",
                phase="disabled",
                meta={"reason": "disabled_by_admin"},
            )
            result = {"skipped": True, "reason": "disabled_by_admin"}
            await try_finish_twitter_crawler_run(
                run_id,
                status="disabled",
                phase="disabled",
                summary=result,
            )
            return result
    return await run_tracked(args)


def main() -> None:
    args = build_parser().parse_args()
    result = asyncio.run(run_configured(args, sys.argv[1:]))
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
