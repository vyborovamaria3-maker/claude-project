import argparse

import pytest

from app.admin_twitter_settings import TwitterCrawlerSettingsAdmin
from app.models.twitter_crawler_settings import TwitterCrawlerSettings
from app.services.twitter_crawler_settings import (
    TwitterCrawlerConfig,
    apply_twitter_crawler_config,
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
    )


def test_admin_settings_view_is_singleton_edit_only():
    assert TwitterCrawlerSettingsAdmin.can_create is False
    assert TwitterCrawlerSettingsAdmin.can_edit is True
    assert TwitterCrawlerSettingsAdmin.can_delete is False
    assert "enabled" in TwitterCrawlerSettingsAdmin.form_columns
    assert "process_limit" in TwitterCrawlerSettingsAdmin.form_columns
    assert "network_mode" in TwitterCrawlerSettingsAdmin.form_columns


def test_admin_defaults_respect_explicit_cli_overrides():
    args = argparse.Namespace(
        query_limit=50,
        process_limit=123,
        batch_size=25,
        max_depth=2,
        min_relevance=35.0,
        network_mode="following",
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
    assert args.network_mode == "following"
    assert args.network_limit == 180
    assert args.lease_seconds == 600
    assert args.rescore_limit == 2500


def test_crawler_settings_reject_invalid_operational_ranges():
    settings = TwitterCrawlerSettings()
    with pytest.raises(ValueError):
        settings.process_limit = 0
    with pytest.raises(ValueError):
        settings.min_relevance = 101
    with pytest.raises(ValueError):
        settings.network_mode = "random"
