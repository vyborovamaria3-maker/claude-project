from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from app.api.v1 import twitter_registry_admin_compat as compat
from app.api.v1.router import api_router
from app.api.v1.twitter_registry_admin_compat import LegacyConfigPatch, _legacy_config
from app.models.twitter_crawler_settings import TwitterCrawlerSettings


def test_next_proxy_backend_prefix_is_registered_with_compat_patch_first():
    included = [
        route
        for route in api_router.routes
        if getattr(getattr(route, "include_context", None), "prefix", None)
        == "/admin/twitter-registry"
    ]
    assert len(included) >= 2
    compat_routes = [
        route
        for route in included[0].original_router.routes
        if getattr(route, "path", "") == "/config"
        and "PATCH" in getattr(route, "methods", set())
    ]
    assert compat_routes
    assert compat_routes[0].endpoint.__module__.endswith("twitter_registry_admin_compat")


def test_legacy_config_is_derived_from_canonical_crawler_settings():
    row = TwitterCrawlerSettings(
        id=1,
        enabled=True,
        query_limit=50,
        process_limit=321,
        batch_size=33,
        max_depth=3,
        min_relevance=44.0,
        network_mode="following",
        network_limit=120,
        lease_seconds=300,
        rescore_limit=1700,
        public_enabled=True,
        public_dexscreener_latest=True,
        public_dexscreener_boosts=False,
        public_db_solana_tokens=500,
        public_cmc_limit=75,
        public_rescore_limit=3000,
        updated_at=datetime(2026, 9, 13, 12, 0, tzinfo=timezone.utc),
    )
    payload = _legacy_config(row, x_api_configured=True)
    assert payload["discovery_enabled"] is True
    assert payload["dexscreener_enabled"] is True
    assert payload["coinmarketcap_enabled"] is True
    assert payload["cmc_limit"] == 75
    assert payload["process_limit"] == 321
    assert payload["min_relevance"] == 44.0
    assert payload["updated_by"] == "canonical_crawler_settings"


def test_legacy_patch_rejects_unknown_and_invalid_values():
    valid = LegacyConfigPatch.model_validate({"process_limit": 500, "min_relevance": 20})
    assert valid.process_limit == 500

    for payload in (
        {"process_limit": 0},
        {"network_limit": 1001},
        {"min_relevance": float("nan")},
        {"unknown": True},
    ):
        try:
            LegacyConfigPatch.model_validate(payload)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid legacy config accepted: {payload!r}")


class _NoRunningResult:
    def scalar_one_or_none(self):
        return None


class _NoRunningSession:
    async def execute(self, _statement):
        return _NoRunningResult()


@pytest.mark.asyncio
async def test_manual_run_reports_conflict_if_atomic_run_claim_loses_race(monkeypatch):
    async def already_running(_args, _argv):
        return {"skipped": True, "reason": "already_running"}

    monkeypatch.setattr(compat, "run_cycle_configured", already_running)

    with pytest.raises(HTTPException) as exc:
        await compat.run_now(session=_NoRunningSession())

    assert exc.value.status_code == 409
    assert "already in progress" in str(exc.value.detail)
