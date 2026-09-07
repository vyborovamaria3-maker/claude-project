from __future__ import annotations

from pathlib import Path

from app.core.runtime_flags import telegram_runtime_in_api
from app.services.analysis_jobs import analysis_request_fingerprint
from app.tasks.celery_app import celery_app


def test_telegram_runtime_is_external_by_default_in_production(monkeypatch) -> None:
    monkeypatch.delenv("TG_RUNTIME_IN_API", raising=False)
    monkeypatch.setenv("ENVIRONMENT", "production")
    assert telegram_runtime_in_api() is False

    monkeypatch.setenv("ENVIRONMENT", "development")
    assert telegram_runtime_in_api() is True

    monkeypatch.setenv("TG_RUNTIME_IN_API", "false")
    assert telegram_runtime_in_api() is False
    monkeypatch.setenv("TG_RUNTIME_IN_API", "true")
    assert telegram_runtime_in_api() is True


def test_celery_routes_isolate_heavy_workloads() -> None:
    routes = dict(celery_app.conf.task_routes or {})
    assert routes["app.tasks.etl.collect_tokens"]["queue"] == "market"
    assert routes["app.tasks.etl.refresh_metrics"]["queue"] == "market"
    assert routes["app.tasks.etl.refresh_links"]["queue"] == "blockchain"
    assert routes["app.tasks.social.refresh_x"]["queue"] == "social"
    assert (
        routes["app.tasks.advanced_intelligence.enrich_report"]["queue"]
        == "intelligence"
    )
    assert (
        routes["app.tasks.intelligence.evaluate_matured_outcomes"]["queue"]
        == "intelligence"
    )
    assert celery_app.conf.worker_prefetch_multiplier == 1
    assert celery_app.conf.task_acks_late is True


def test_analysis_fingerprint_is_stable_and_contract_sensitive() -> None:
    snapshot = {
        "snapshotId": "snapshot-1",
        "mint": "So11111111111111111111111111111111111111112",
        "features": [{"key": "x.score", "value": 42}],
    }
    ai_result = {"campaignHypothesis": {"label": "mixed"}}

    first = analysis_request_fingerprint(
        snapshot=snapshot,
        ai_result=ai_result,
        role="analyst",
        enrich=True,
        persist=True,
    )
    reordered = analysis_request_fingerprint(
        snapshot={
            "features": snapshot["features"],
            "mint": snapshot["mint"],
            "snapshotId": "snapshot-1",
        },
        ai_result=ai_result,
        role="analyst",
        enrich=True,
        persist=True,
    )
    no_enrichment = analysis_request_fingerprint(
        snapshot=snapshot,
        ai_result=ai_result,
        role="analyst",
        enrich=False,
        persist=True,
    )
    critic = analysis_request_fingerprint(
        snapshot=snapshot,
        ai_result=ai_result,
        role="critic",
        enrich=True,
        persist=True,
    )

    assert first == reordered
    assert first != no_enrichment
    assert first != critic


def test_production_compose_has_dedicated_analysis_workers() -> None:
    compose = (
        Path(__file__).resolve().parents[2] / "docker-compose.production.yml"
    ).read_text(encoding="utf-8")

    assert "celery-market:" in compose
    assert "celery-social:" in compose
    assert "celery-intelligence:" in compose
    assert "celery-blockchain:" in compose
    assert '"-Q", "market"' in compose
    assert '"-Q", "social"' in compose
    assert '"-Q", "intelligence"' in compose
    assert '"-Q", "blockchain"' in compose
    assert 'TG_RUNTIME_IN_API: "false"' in compose
    assert 'command: ["python", "-m", "app.cli.telegram_runtime"]' in compose
