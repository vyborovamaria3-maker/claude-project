from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
from pathlib import Path
from typing import Any

import httpx

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.services.twitter_discovery import (
    claim_discovery_candidates,
    discovery_stats,
    enqueue_discovery_candidate,
    mark_candidate_failed,
    profile_from_meta,
    profile_to_meta,
    promote_candidate,
    reject_candidate,
)
from app.services.twitter_discovery_sources import (
    DiscoveryRateLimited,
    PublicWebDiscoverySource,
    XApiDiscoverySource,
    load_queries,
    load_seed_records,
)

DEFAULT_SEED_FILE = "data/twitter-discovery/crypto_media_seeds.json"
DEFAULT_QUERIES_FILE = "data/twitter-discovery/queries.json"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Discover crypto, Solana, memecoin, trading and media X accounts into "
            "the persistent Twitter intelligence registry."
        )
    )
    parser.add_argument("--seed-file", default=DEFAULT_SEED_FILE)
    parser.add_argument("--queries-file", default=DEFAULT_QUERIES_FILE)
    parser.add_argument("--public-url", action="append", default=[])
    parser.add_argument("--skip-seeds", action="store_true")
    parser.add_argument("--skip-x-search", action="store_true")
    parser.add_argument("--skip-frontier", action="store_true")
    parser.add_argument("--query-limit", type=int, default=50)
    parser.add_argument("--process-limit", type=int, default=250)
    parser.add_argument("--batch-size", type=int, default=25)
    parser.add_argument("--max-depth", type=int, default=2)
    parser.add_argument("--min-relevance", type=float, default=35.0)
    parser.add_argument(
        "--network-mode",
        choices=("none", "following", "followers", "both"),
        default="following",
    )
    parser.add_argument("--network-limit", type=int, default=100)
    parser.add_argument("--lease-seconds", type=int, default=300)
    parser.add_argument("--worker-id", default="")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def _directions(mode: str) -> tuple[str, ...]:
    if mode == "both":
        return ("following", "followers")
    if mode in {"following", "followers"}:
        return (mode,)
    return ()


async def _ingest_seeds(session: Any, path: str) -> int:
    count = 0
    for record in load_seed_records(path):
        await enqueue_discovery_candidate(
            session,
            twitter_id=record.twitter_id,
            username=record.username,
            account_type_hint=record.account_type,
            priority=record.priority,
            depth=0,
            relevance_hint=record.relevance_hint,
            source_type="curated_seed",
            source_ref=str(Path(path)),
            discovery_reason=record.reason,
            source_url=record.source_url,
        )
        count += 1
    return count


async def _ingest_public_urls(
    session: Any,
    source: PublicWebDiscoverySource,
    urls: list[str],
) -> tuple[int, list[str]]:
    discovered = 0
    errors: list[str] = []
    for url in urls:
        try:
            handles = await source.discover_handles(url)
        except httpx.HTTPError as exc:
            errors.append(f"{url}: {exc}")
            continue
        for username in handles:
            await enqueue_discovery_candidate(
                session,
                username=username,
                priority=60,
                depth=0,
                relevance_hint=35.0,
                source_type="public_web",
                source_ref=url,
                discovery_reason="explicit_x_profile_link",
                source_url=url,
            )
            discovered += 1
    return discovered, errors


async def _ingest_x_search(
    session: Any,
    source: XApiDiscoverySource,
    queries: list[str],
    *,
    query_limit: int,
) -> tuple[int, list[str], bool]:
    discovered = 0
    errors: list[str] = []
    rate_limited = False
    for query in queries:
        try:
            profiles = await source.search_accounts(query, max_results=query_limit)
        except DiscoveryRateLimited as exc:
            errors.append(str(exc))
            rate_limited = True
            break
        except httpx.HTTPError as exc:
            errors.append(f"query={query!r}: {exc}")
            continue
        for profile in profiles:
            await enqueue_discovery_candidate(
                session,
                twitter_id=profile.twitter_id,
                username=profile.username,
                display_name=profile.display_name,
                priority=75,
                depth=0,
                relevance_hint=40.0,
                source_type="x_search",
                source_ref=query,
                discovery_reason="crypto_query_author_or_mention",
                query=query,
                evidence_raw=profile.raw,
                meta={"resolved_profile": profile_to_meta(profile)},
            )
            discovered += 1
    return discovered, errors, rate_limited


async def _expand_network(
    session: Any,
    source: XApiDiscoverySource,
    *,
    candidate: Any,
    twitter_id: str,
    account_id: int,
    max_depth: int,
    network_mode: str,
    network_limit: int,
) -> int:
    if candidate.depth >= max_depth:
        return 0
    discovered = 0
    for direction in _directions(network_mode):
        profiles = await source.network_accounts(
            twitter_id,
            direction=direction,
            max_results=network_limit,
        )
        for profile in profiles:
            await enqueue_discovery_candidate(
                session,
                twitter_id=profile.twitter_id,
                username=profile.username,
                display_name=profile.display_name,
                priority=max(10, candidate.priority - 10),
                depth=candidate.depth + 1,
                relevance_hint=15.0,
                parent_account_id=account_id,
                source_type=f"x_{direction}",
                source_ref=f"{twitter_id}:{direction}",
                discovery_reason=f"network_{direction}",
                evidence_raw=profile.raw,
                meta={"resolved_profile": profile_to_meta(profile)},
            )
            discovered += 1
    return discovered


async def _process_frontier(
    sessionmaker: Any,
    source: XApiDiscoverySource,
    *,
    worker_id: str,
    process_limit: int,
    batch_size: int,
    max_depth: int,
    min_relevance: float,
    network_mode: str,
    network_limit: int,
    lease_seconds: int,
    dry_run: bool,
) -> dict[str, int]:
    counters = {
        "processed": 0,
        "accepted": 0,
        "rejected": 0,
        "failed": 0,
        "network_discovered": 0,
        "rate_limited": 0,
    }
    stop = False
    while counters["processed"] < process_limit and not stop:
        remaining = process_limit - counters["processed"]
        async with sessionmaker() as session:
            candidates = await claim_discovery_candidates(
                session,
                worker_id=worker_id,
                limit=min(batch_size, remaining),
                lease_seconds=lease_seconds,
            )
            if not candidates:
                await session.rollback()
                break
            if dry_run:
                await session.rollback()
                counters["processed"] += len(candidates)
                break
            await session.commit()

            for candidate in candidates:
                counters["processed"] += 1
                try:
                    profile = profile_from_meta(candidate.meta)
                    if profile is None:
                        profile = await source.resolve_profile(
                            twitter_id=candidate.twitter_id,
                            username=candidate.username,
                        )
                    if profile is None:
                        await reject_candidate(
                            session,
                            candidate,
                            reason="x_profile_not_found",
                        )
                        counters["rejected"] += 1
                        continue

                    accepted, account_id, _ = await promote_candidate(
                        session,
                        candidate,
                        profile,
                        min_relevance=min_relevance,
                    )
                    if not accepted or account_id is None:
                        counters["rejected"] += 1
                        continue
                    counters["accepted"] += 1

                    if network_mode != "none" and candidate.depth < max_depth:
                        candidate.status = "processing"
                        try:
                            added = await _expand_network(
                                session,
                                source,
                                candidate=candidate,
                                twitter_id=profile.twitter_id,
                                account_id=account_id,
                                max_depth=max_depth,
                                network_mode=network_mode,
                                network_limit=network_limit,
                            )
                            counters["network_discovered"] += added
                            candidate.status = "accepted"
                            candidate.meta = {
                                **(candidate.meta or {}),
                                "network_expanded": network_mode,
                            }
                        except DiscoveryRateLimited as exc:
                            await mark_candidate_failed(
                                session,
                                candidate,
                                error=str(exc),
                                base_backoff_seconds=exc.retry_after_seconds,
                            )
                            counters["rate_limited"] += 1
                            stop = True
                        except httpx.HTTPError as exc:
                            await mark_candidate_failed(
                                session,
                                candidate,
                                error=f"network_http_error:{exc}",
                            )
                            counters["failed"] += 1
                except DiscoveryRateLimited as exc:
                    await mark_candidate_failed(
                        session,
                        candidate,
                        error=str(exc),
                        base_backoff_seconds=exc.retry_after_seconds,
                    )
                    counters["rate_limited"] += 1
                    stop = True
                except httpx.HTTPStatusError as exc:
                    if exc.response.status_code == 404:
                        await reject_candidate(
                            session,
                            candidate,
                            reason="x_profile_not_found",
                        )
                        counters["rejected"] += 1
                    else:
                        await mark_candidate_failed(
                            session,
                            candidate,
                            error=f"x_http_{exc.response.status_code}:{exc}",
                        )
                        counters["failed"] += 1
                except (httpx.HTTPError, ValueError) as exc:
                    await mark_candidate_failed(
                        session,
                        candidate,
                        error=f"discovery_error:{exc}",
                    )
                    counters["failed"] += 1
                if stop:
                    break

            await session.commit()
    return counters


async def run(args: argparse.Namespace) -> dict[str, Any]:
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    worker_id = args.worker_id.strip() or f"{socket.gethostname()}:{os.getpid()}"
    summary: dict[str, Any] = {
        "worker_id": worker_id,
        "dry_run": bool(args.dry_run),
        "seed_discovered": 0,
        "public_web_discovered": 0,
        "x_search_discovered": 0,
        "public_web_errors": [],
        "x_search_errors": [],
        "x_api_configured": bool(settings.x_api_bearer_token.strip()),
    }

    timeout = httpx.Timeout(20.0, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        public_source = PublicWebDiscoverySource(client=client)
        x_source = (
            XApiDiscoverySource(
                bearer_token=settings.x_api_bearer_token,
                client=client,
                base_url=settings.x_api_base_url,
            )
            if settings.x_api_bearer_token.strip()
            else None
        )

        async with sessionmaker() as session:
            if not args.skip_seeds:
                summary["seed_discovered"] = await _ingest_seeds(
                    session,
                    args.seed_file,
                )
            if args.public_url:
                discovered, errors = await _ingest_public_urls(
                    session,
                    public_source,
                    args.public_url,
                )
                summary["public_web_discovered"] = discovered
                summary["public_web_errors"] = errors
            if x_source is not None and not args.skip_x_search:
                queries = load_queries(args.queries_file)
                discovered, errors, rate_limited = await _ingest_x_search(
                    session,
                    x_source,
                    queries,
                    query_limit=args.query_limit,
                )
                summary["x_search_discovered"] = discovered
                summary["x_search_errors"] = errors
                summary["x_search_rate_limited"] = rate_limited
            if args.dry_run:
                await session.rollback()
            else:
                await session.commit()

        if x_source is not None and not args.skip_frontier:
            summary["frontier"] = await _process_frontier(
                sessionmaker,
                x_source,
                worker_id=worker_id,
                process_limit=max(1, args.process_limit),
                batch_size=max(1, args.batch_size),
                max_depth=max(0, args.max_depth),
                min_relevance=max(0.0, min(100.0, args.min_relevance)),
                network_mode=args.network_mode,
                network_limit=max(1, args.network_limit),
                lease_seconds=max(30, args.lease_seconds),
                dry_run=bool(args.dry_run),
            )
        elif x_source is None:
            summary["frontier_skipped"] = "X_API_BEARER_TOKEN is not configured"

    async with sessionmaker() as session:
        summary["database"] = await discovery_stats(session)
    await engine.dispose()
    return summary


def main() -> None:
    args = build_parser().parse_args()
    summary = asyncio.run(run(args))
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
