from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.api.v1.twitter_crawler_admin import (
    SETTING_FIELDS,
    TwitterCrawlerSettingsUpdate,
    update_crawler_settings,
)

TEST_KEY = "unit-test-placeholder-key-value-0001"


def _payload() -> dict:
    return {
        "expected_updated_at": "2026-09-13T12:00:00+00:00",
        "enabled": True,
        "query_limit": 50,
        "process_limit": 250,
        "batch_size": 25,
        "max_depth": 2,
        "min_relevance": 35.0,
        "network_mode": "following",
        "network_limit": 100,
        "lease_seconds": 300,
        "rescore_limit": 1500,
        "public_enabled": True,
        "public_dexscreener_latest": True,
        "public_dexscreener_boosts": True,
        "public_db_solana_tokens": 500,
        "public_cmc_limit": 0,
        "public_rescore_limit": 3000,
    }


def _row() -> dict:
    payload = _payload()
    payload.pop("expected_updated_at")
    return {
        "id": 1,
        **payload,
        "updated_at": datetime(2026, 9, 13, 12, 1, tzinfo=timezone.utc),
    }


class _Mappings:
    def __init__(self, row):
        self.row = row

    def one_or_none(self):
        return self.row


class _Result:
    def __init__(self, row):
        self.row = row

    def mappings(self):
        return _Mappings(self.row)


class _Session:
    def __init__(self, row):
        self.row = row
        self.executed = False
        self.committed = False
        self.rolled_back = False

    async def execute(self, _statement):
        self.executed = True
        return _Result(self.row)

    async def commit(self):
        self.committed = True

    async def rollback(self):
        self.rolled_back = True


def test_schema_matches_operational_settings_contract():
    body = TwitterCrawlerSettingsUpdate.model_validate(_payload())
    values = body.model_dump(exclude={"expected_updated_at"})
    assert set(values) == set(SETTING_FIELDS)

    invalid = _payload()
    invalid["query_limit"] = 9
    with pytest.raises(ValidationError):
        TwitterCrawlerSettingsUpdate.model_validate(invalid)

    invalid = _payload()
    invalid["expected_updated_at"] = "2026-09-13T12:00:00"
    with pytest.raises(ValidationError):
        TwitterCrawlerSettingsUpdate.model_validate(invalid)

    invalid = _payload()
    invalid["unexpected"] = True
    with pytest.raises(ValidationError):
        TwitterCrawlerSettingsUpdate.model_validate(invalid)


@pytest.mark.asyncio
async def test_endpoint_requires_dedicated_key_before_db_access(monkeypatch):
    monkeypatch.setenv("TWITTER_CRAWLER_ADMIN_KEY", TEST_KEY)
    session = _Session(_row())

    with pytest.raises(HTTPException) as exc_info:
        await update_crawler_settings(
            TwitterCrawlerSettingsUpdate.model_validate(_payload()),
            session=session,  # type: ignore[arg-type]
            x_twitter_crawler_admin_key="wrong-key",
        )

    assert exc_info.value.status_code == 401
    assert session.executed is False


@pytest.mark.asyncio
async def test_endpoint_commits_successful_optimistic_update(monkeypatch):
    monkeypatch.setenv("TWITTER_CRAWLER_ADMIN_KEY", TEST_KEY)
    session = _Session(_row())

    result = await update_crawler_settings(
        TwitterCrawlerSettingsUpdate.model_validate(_payload()),
        session=session,  # type: ignore[arg-type]
        x_twitter_crawler_admin_key=TEST_KEY,
    )

    assert session.executed is True
    assert session.committed is True
    assert session.rolled_back is False
    assert result["ok"] is True
    assert result["settings"]["id"] == 1
    assert result["settings"]["updated_at"].endswith("+00:00")


@pytest.mark.asyncio
async def test_endpoint_returns_409_and_rolls_back_on_version_conflict(monkeypatch):
    monkeypatch.setenv("TWITTER_CRAWLER_ADMIN_KEY", TEST_KEY)
    session = _Session(None)

    with pytest.raises(HTTPException) as exc_info:
        await update_crawler_settings(
            TwitterCrawlerSettingsUpdate.model_validate(_payload()),
            session=session,  # type: ignore[arg-type]
            x_twitter_crawler_admin_key=TEST_KEY,
        )

    assert exc_info.value.status_code == 409
    assert session.committed is False
    assert session.rolled_back is True
