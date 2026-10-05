import argparse

import pytest
from app.admin_twitter_settings import TwitterCrawlerSettingsAdmin
from app.models.twitter_crawler_settings import TwitterCrawlerSettings
from app.services.twitter_crawler_settings import (
    TwitterCrawlerConfig,
    apply_twitter_crawler_config,
    apply_twitter_public_config,
    explicit_cli_flags,
)


def _config() -> TwitterCrawlerConfig:
    return TwitterCrawlerConfig(
        enabled=True,
        query_limit=80,
        process_limit=900,
        batch_size=40,
        max_depth=4,
        min_relevance=55.0,
        network_mode="both",
        network_limit=180,
        lease_seconds=600,
        rescore_limit=2500,
        public_enabled=True,
        public_dexscreener_latest=True,
        public_dexscreener_boosts=True,
        public_db_solana_tokens=700,
        public_cmc_limit=900,
        public_rescore_limit=3200,
    )


def test_sqladmin_settings_view_is_read_only_to_keep_single_writer():
    assert TwitterCrawlerSettingsAdmin.can_create is False
    assert TwitterCrawlerSettingsAdmin.can_edit is False
    assert TwitterCrawlerSettingsAdmin.can_delete is False
    assert {
        "enabled",
        "process_limit",
        "network_mode",
        "public_enabled",
        "public_dexscreener_latest",
        "public_db_solana_tokens",
        "updated_at",
    }.issubset(set(TwitterCrawlerSettingsAdmin.column_list))


def test_admin_defaults_respect_explicit_cli_overrides():
    args = argparse.Namespace(
        query_limit=50,
        process_limit=123,
        batch_size=25,
        max_depth=2,
        min_relevance=35.0,
        network_mode="followers",
        network_limit=100,
        lease_seconds=300,
        rescore_limit=1500,
    )
    flags = explicit_cli_flags(["--process-limit", "123", "--network-mode=followers"])

    apply_twitter_crawler_config(args, _config(), explicit_flags=flags)

    assert args.query_limit == 80
    assert args.process_limit == 123
    assert args.batch_size == 40
    assert args.max_depth == 4
    assert args.min_relevance == 55.0
    assert args.network_mode == "followers"
    assert args.network_limit == 180
    assert args.lease_seconds == 600
    assert args.rescore_limit == 2500


def test_public_admin_defaults_apply_without_cli_overrides():
    args = argparse.Namespace(
        dexscreener_latest=False,
        dexscreener_boosts=False,
        db_solana_tokens=0,
        cmc_limit=0,
        rescore_limit=3000,
    )

    apply_twitter_public_config(args, _config(), explicit_flags=set())

    assert args.dexscreener_latest is True
    assert args.dexscreener_boosts is True
    assert args.db_solana_tokens == 700
    assert args.cmc_limit == 900
    assert args.rescore_limit == 3200


def test_public_cli_flags_override_admin_defaults_including_negative_flags():
    args = argparse.Namespace(
        dexscreener_latest=False,
        dexscreener_boosts=True,
        db_solana_tokens=12,
        cmc_limit=34,
        rescore_limit=56,
    )
    flags = explicit_cli_flags(
        [
            "--no-dexscreener-latest",
            "--dexscreener-boosts",
            "--db-solana-tokens=12",
            "--cmc-limit",
            "34",
            "--rescore-limit=56",
        ]
    )

    apply_twitter_public_config(args, _config(), explicit_flags=flags)

    assert args.dexscreener_latest is False
    assert args.dexscreener_boosts is True
    assert args.db_solana_tokens == 12
    assert args.cmc_limit == 34
    assert args.rescore_limit == 56


def test_crawler_settings_reject_invalid_operational_ranges():
    settings = TwitterCrawlerSettings()
    with pytest.raises(ValueError):
        settings.query_limit = 9
    with pytest.raises(ValueError):
        settings.process_limit = 0
    with pytest.raises(ValueError):
        settings.min_relevance = 101
    with pytest.raises(ValueError):
        settings.min_relevance = float("nan")
    with pytest.raises(ValueError):
        settings.network_mode = "random"
    with pytest.raises(ValueError):
        settings.network_mode = None  # type: ignore[assignment]
    with pytest.raises(ValueError):
        settings.public_db_solana_tokens = 10001
    with pytest.raises(ValueError):
        settings.public_cmc_limit = 5001
    with pytest.raises(ValueError):
        settings.public_rescore_limit = -1
