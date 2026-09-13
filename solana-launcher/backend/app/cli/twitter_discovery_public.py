from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

import httpx
from sqlalchemy import select

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.models.analytics import Token
from app.services.twitter_crawler_runs import (
    try_finish_twitter_crawler_run,
    try_heartbeat_twitter_crawler_run,
    try_start_twitter_crawler_run,
)
from app.services.twitter_crawler_settings import (
    apply_twitter_public_config,
    explicit_cli_flags,
    load_twitter_crawler_config,
)
from app.services.twitter_discovery import discovery_stats, enqueue_discovery_candidate
from app.services.twitter_discovery_scoring import rescore_discovery_candidates
from app.services.twitter_public_discovery_sources import (
    CoinMarketCapKeylessDiscoverySource,
    DexScreenerDiscoverySource,
    PublicHandle,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Discover crypto/memecoin X handles without requiring the official X API."
    )
    parser.add_argument(
        "--dexscreener-latest",
        action=argparse.BooleanOptionalAction,
        default=False,
    )
    parser.add_argument(
        "--dexscreener-boosts",
        action=argparse.BooleanOptionalAction,
        default=False,
    )
    parser.add_argument("--db-solana-tokens", type=int, default=0)
    parser.add_argument("--cmc-limit", type=int, default=0)
    parser.add_argument("--rescore-limit", type=int, default=3000)
    parser.add_argument("--dry-run", action="store_true")
    return parser


async def _enqueue(session: Any, handles: list[PublicHandle]) -> int:
    count = 0
    for item in handles:
        provider = item.source_type[:48]
        await enqueue_discovery_candidate(
            session,
            username=item.username,
            account_type_hint=item.account_type_hint,
            priority=max(50, int(item.relevance_hint)),
            depth=0,
            relevance_hint=item.relevance_hint,
            source_type="public_web",
            source_ref=f"{provider}:{item.source_ref}"[:512],
            discovery_reason=f"official_social_link:{provider}"[:96],
            source_url=item.source_url,
            evidence_raw={
                "provider": provider,
                "payload": item.raw,
            },
        )
        count += 1
    return count


async def _token_addresses(session: Any, limit: int) -> list[str]:
    if limit <= 0:
        return []
    rows = (
        await session.execute(
            select(Token.mint_address)
            .where(Token.mint_address.is_not(None))
            .order_by(Token.id.desc())
            .limit(min(max(1, int(limit)), 10000))
        )
    ).scalars().all()
    return [str(value) for value in rows if value]


async def run(
    args: argparse.Namespace,
    *,
    run_id: int | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    timeout = httpx.Timeout(20.0, connect=10.0)
    summary: dict[str, Any] = {
        "mode": "public_no_x_api",
        "x_api_required": False,
        "dexscreener_latest": 0,
        "dexscreener_boosts": 0,
        "dexscreener_db_tokens": 0,
        "cmc_keyless": 0,
        "errors": [],
    }

    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            dex = DexScreenerDiscoverySource(client=client)
            cmc = CoinMarketCapKeylessDiscoverySource(client=client)
            async with sessionmaker() as session:
                if args.dexscreener_latest:
                    await try_heartbeat_twitter_crawler_run(
                        run_id,
                        phase="public_dexscreener_latest",
                        summary=summary,
                    )
                    try:
                        summary["dexscreener_latest"] = await _enqueue(
                            session, await dex.latest_token_profiles()
                        )
                    except (httpx.HTTPError, ValueError) as exc:
                        summary["errors"].append(f"dexscreener_latest:{exc}")

                if args.dexscreener_boosts:
                    await try_heartbeat_twitter_crawler_run(
                        run_id,
                        phase="public_dexscreener_boosts",
                        summary=summary,
                    )
                    try:
                        summary["dexscreener_boosts"] = await _enqueue(
                            session, await dex.latest_boosts()
                        )
                    except (httpx.HTTPError, ValueError) as exc:
                        summary["errors"].append(f"dexscreener_boosts:{exc}")

                addresses = await _token_addresses(session, args.db_solana_tokens)
                if addresses:
                    await try_heartbeat_twitter_crawler_run(
                        run_id,
                        phase="public_dexscreener_db_tokens",
                        summary={**summary, "db_tokens_total": len(addresses)},
                    )
                for batch_number, offset in enumerate(range(0, len(addresses), 30), start=1):
                    try:
                        summary["dexscreener_db_tokens"] += await _enqueue(
                            session, await dex.token_socials(addresses[offset : offset + 30])
                        )
                    except (httpx.HTTPError, ValueError) as exc:
                        summary["errors"].append(f"dexscreener_token_batch:{offset}:{exc}")
                    if batch_number % 50 == 0:
                        await try_heartbeat_twitter_crawler_run(
                            run_id,
                            phase="public_dexscreener_db_tokens",
                            summary={
                                **summary,
                                "db_tokens_total": len(addresses),
                                "db_tokens_processed": min(offset + 30, len(addresses)),
                            },
                        )

                if args.cmc_limit > 0:
                    await try_heartbeat_twitter_crawler_run(
                        run_id,
                        phase="public_coinmarketcap",
                        summary=summary,
                    )
                    try:
                        summary["cmc_keyless"] = await _enqueue(
                            session, await cmc.discover(limit=args.cmc_limit)
                        )
                    except (httpx.HTTPError, ValueError) as exc:
                        summary["errors"].append(f"cmc_keyless:{exc}")

                if args.dry_run:
                    await session.rollback()
                else:
                    await session.commit()

            if not args.dry_run and args.rescore_limit > 0:
                await try_heartbeat_twitter_crawler_run(
                    run_id,
                    phase="public_rescore",
                    summary=summary,
                )
                async with sessionmaker() as session:
                    summary["rescore"] = await rescore_discovery_candidates(
                        session,
                        limit=max(1, min(int(args.rescore_limit), 5000)),
                    )
                    await session.commit()

        async with sessionmaker() as session:
            summary["database"] = await discovery_stats(session)
        return summary
    finally:
        await engine.dispose()


async def run_tracked(args: argparse.Namespace) -> dict[str, Any]:
    run_id = await try_start_twitter_crawler_run(
        "twitter_discovery_public",
        meta={
            "dexscreener_latest": bool(args.dexscreener_latest),
            "dexscreener_boosts": bool(args.dexscreener_boosts),
            "db_solana_tokens": int(args.db_solana_tokens),
            "cmc_limit": int(args.cmc_limit),
            "rescore_limit": int(args.rescore_limit),
            "dry_run": bool(args.dry_run),
        },
    )
    if run_id is None:
        return {"skipped": True, "reason": "already_running"}

    try:
        summary = await run(args, run_id=run_id)
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

    errors = summary.get("errors") or []
    await try_finish_twitter_crawler_run(
        run_id,
        status="degraded" if errors else "success",
        phase="complete",
        summary=summary,
        error="; ".join(str(item) for item in errors)[:4000] if errors else None,
    )
    return summary


async def run_configured(args: argparse.Namespace, argv: list[str]) -> dict[str, Any]:
    config = await load_twitter_crawler_config()
    if config is not None:
        apply_twitter_public_config(
            args,
            config,
            explicit_flags=explicit_cli_flags(argv),
        )
        if not config.public_enabled:
            run_id = await try_start_twitter_crawler_run(
                "twitter_discovery_public",
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
    summary = asyncio.run(run_configured(args, sys.argv[1:]))
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
