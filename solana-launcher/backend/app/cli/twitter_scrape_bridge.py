from __future__ import annotations

import argparse
import asyncio
import json
from urllib.parse import urlencode

import httpx

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.twitter_crawler_runs import (
    try_finish_twitter_crawler_run,
    try_heartbeat_twitter_crawler_run,
    try_start_twitter_crawler_run,
)
from app.services.twitter_scrape_bridge import ingest_dev_twitter_stats


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Reuse the existing Next.js dev-twitter Nitter/Playwright collector and "
            "ingest its parsed tweets into the persistent Twitter discovery registry."
        )
    )
    parser.add_argument("--mint", required=True)
    parser.add_argument("--symbol", default="")
    parser.add_argument("--twitter", default="")
    parser.add_argument("--scope", choices=("mentions", "official"), default="mentions")
    parser.add_argument("--strategy", choices=("auto", "nitter", "playwright"), default="auto")
    parser.add_argument("--limit", type=int, default=60)
    parser.add_argument("--hours", default="24")
    parser.add_argument("--frontend-base", default="")
    parser.add_argument("--timeout", type=float, default=90.0)
    return parser


def _collector_base(args: argparse.Namespace, settings: object) -> str:
    explicit = args.frontend_base.strip()
    if explicit:
        return explicit.rstrip("/")
    environment = str(getattr(settings, "environment", "development")).strip().lower()
    if environment in {"production", "prod", "docker"}:
        return str(getattr(settings, "frontend_internal_url", "http://frontend:3000")).rstrip("/")
    return "http://localhost:3000"


async def run(args: argparse.Namespace, *, run_id: int | None = None) -> dict[str, object]:
    settings = get_settings()
    frontend_base = _collector_base(args, settings)
    mint = args.mint.strip()
    if not mint:
        raise ValueError("--mint must not be empty")
    params = {
        "mint": mint,
        "strategy": args.strategy,
        "scope": args.scope,
        "limit": str(max(5, min(100, int(args.limit)))),
        "hours": str(args.hours),
        "excludeSuspicious": "false",
        "verifiedOnly": "false",
    }
    if args.symbol.strip():
        params["symbol"] = args.symbol.strip().lstrip("$")
    if args.twitter.strip():
        params["twitter"] = args.twitter.strip().lstrip("@")

    url = f"{frontend_base}/api/trade/dev-twitter?{urlencode(params)}"
    timeout = httpx.Timeout(max(5.0, float(args.timeout)), connect=10.0)
    await try_heartbeat_twitter_crawler_run(run_id, phase="collect")
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        response = await client.get(url)
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError("dev-twitter returned a non-object payload")
    if payload.get("error"):
        raise RuntimeError(f"dev-twitter error: {payload.get('error')}")

    await try_heartbeat_twitter_crawler_run(
        run_id,
        phase="ingest",
        summary={
            "collection_strategy": payload.get("collectionStrategy"),
            "total_tweets": payload.get("totalTweets", 0),
            "top_tweets": len(payload.get("topTweets") or []),
            "shillers": len(payload.get("shillers") or []),
        },
    )
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    try:
        async with sessionmaker() as session:
            ingest = await ingest_dev_twitter_stats(
                session,
                payload,
                mint=mint,
                symbol=(args.symbol.strip().lstrip("$") or payload.get("symbol") or None),
            )
            await session.commit()
    finally:
        await engine.dispose()

    return {
        "collector_url": url,
        "collection_strategy": payload.get("collectionStrategy"),
        "twitter_handle": payload.get("twitterHandle"),
        "total_tweets": payload.get("totalTweets", 0),
        "top_tweets": len(payload.get("topTweets") or []),
        "shillers": len(payload.get("shillers") or []),
        "registry": ingest,
    }


async def run_tracked(args: argparse.Namespace) -> dict[str, object]:
    run_id = await try_start_twitter_crawler_run(
        "twitter_scrape_bridge",
        meta={
            "mint": args.mint.strip(),
            "symbol": args.symbol.strip().lstrip("$"),
            "scope": args.scope,
            "strategy": args.strategy,
            "limit": int(args.limit),
            "hours": str(args.hours),
        },
    )
    if run_id is None:
        return {"skipped": True, "reason": "already_running"}

    try:
        result = await run(args, run_id=run_id)
    except asyncio.CancelledError:
        await try_finish_twitter_crawler_run(
            run_id,
            status="cancelled",
            phase="cancelled",
            error="crawler task was cancelled",
        )
        raise
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


def main() -> None:
    args = build_parser().parse_args()
    result = asyncio.run(run_tracked(args))
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
