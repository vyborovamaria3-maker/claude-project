from __future__ import annotations

import argparse
import asyncio
import json
from urllib.parse import urlencode

import httpx

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
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


async def run(args: argparse.Namespace) -> dict[str, object]:
    settings = get_settings()
    frontend_base = (args.frontend_base.strip() or settings.frontend_url).rstrip("/")
    params = {
        "mint": args.mint.strip(),
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
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.get(url)
        response.raise_for_status()
        payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError("dev-twitter returned a non-object payload")

    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    try:
        async with sessionmaker() as session:
            ingest = await ingest_dev_twitter_stats(
                session,
                payload,
                mint=args.mint.strip(),
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


def main() -> None:
    args = build_parser().parse_args()
    result = asyncio.run(run(args))
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
