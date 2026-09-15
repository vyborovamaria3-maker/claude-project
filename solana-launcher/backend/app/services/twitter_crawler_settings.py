from __future__ import annotations

import logging
from dataclasses import dataclass

from app.core.config import get_settings
from app.db.session import create_engine_and_sessionmaker
from app.models.twitter_crawler_settings import TwitterCrawlerSettings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TwitterCrawlerConfig:
    enabled: bool
    query_limit: int
    process_limit: int
    batch_size: int
    max_depth: int
    min_relevance: float
    network_mode: str
    network_limit: int
    lease_seconds: int
    rescore_limit: int
    public_enabled: bool
    public_dexscreener_latest: bool
    public_dexscreener_boosts: bool
    public_db_solana_tokens: int
    public_cmc_limit: int
    public_rescore_limit: int


async def load_twitter_crawler_config() -> TwitterCrawlerConfig | None:
    settings = get_settings()
    engine, sessionmaker = create_engine_and_sessionmaker(settings)
    try:
        async with sessionmaker() as session:
            row = await session.get(TwitterCrawlerSettings, 1)
            if row is None:
                row = TwitterCrawlerSettings(id=1)
                session.add(row)
                await session.flush()
                await session.commit()
            return TwitterCrawlerConfig(
                enabled=bool(row.enabled),
                query_limit=int(row.query_limit),
                process_limit=int(row.process_limit),
                batch_size=int(row.batch_size),
                max_depth=int(row.max_depth),
                min_relevance=float(row.min_relevance),
                network_mode=str(row.network_mode),
                network_limit=int(row.network_limit),
                lease_seconds=int(row.lease_seconds),
                rescore_limit=int(row.rescore_limit),
                public_enabled=bool(row.public_enabled),
                public_dexscreener_latest=bool(row.public_dexscreener_latest),
                public_dexscreener_boosts=bool(row.public_dexscreener_boosts),
                public_db_solana_tokens=int(row.public_db_solana_tokens),
                public_cmc_limit=int(row.public_cmc_limit),
                public_rescore_limit=int(row.public_rescore_limit),
            )
    except Exception:
        logger.exception(
            "Twitter crawler settings could not be loaded; built-in CLI defaults will be used"
        )
        return None
    finally:
        await engine.dispose()


def explicit_cli_flags(argv: list[str]) -> set[str]:
    return {item.split("=", 1)[0] for item in argv if item.startswith("--")}


def apply_twitter_crawler_config(
    args: object,
    config: TwitterCrawlerConfig,
    *,
    explicit_flags: set[str],
) -> None:
    mappings = (
        ("--query-limit", "query_limit"),
        ("--process-limit", "process_limit"),
        ("--batch-size", "batch_size"),
        ("--max-depth", "max_depth"),
        ("--min-relevance", "min_relevance"),
        ("--network-mode", "network_mode"),
        ("--network-limit", "network_limit"),
        ("--lease-seconds", "lease_seconds"),
        ("--rescore-limit", "rescore_limit"),
    )
    for flag, attribute in mappings:
        if flag not in explicit_flags:
            setattr(args, attribute, getattr(config, attribute))


def apply_twitter_public_config(
    args: object,
    config: TwitterCrawlerConfig,
    *,
    explicit_flags: set[str],
) -> None:
    boolean_mappings = (
        (
            "--dexscreener-latest",
            "--no-dexscreener-latest",
            "dexscreener_latest",
            "public_dexscreener_latest",
        ),
        (
            "--dexscreener-boosts",
            "--no-dexscreener-boosts",
            "dexscreener_boosts",
            "public_dexscreener_boosts",
        ),
    )
    for positive_flag, negative_flag, attribute, config_attribute in boolean_mappings:
        if positive_flag not in explicit_flags and negative_flag not in explicit_flags:
            setattr(args, attribute, getattr(config, config_attribute))

    numeric_mappings = (
        ("--db-solana-tokens", "db_solana_tokens", "public_db_solana_tokens"),
        ("--cmc-limit", "cmc_limit", "public_cmc_limit"),
        ("--rescore-limit", "rescore_limit", "public_rescore_limit"),
    )
    for flag, attribute, config_attribute in numeric_mappings:
        if flag not in explicit_flags:
            setattr(args, attribute, getattr(config, config_attribute))
