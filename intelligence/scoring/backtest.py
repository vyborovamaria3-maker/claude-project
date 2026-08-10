"""Deterministic golden-fixture backtests for versioned intelligence scores."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from intelligence.providers.github.models import RepositorySnapshot
from intelligence.providers.github.scoring import (
    DEVELOPER_SCORE_VERSION,
    calculate_developer_score,
)


DEFAULT_DEVELOPER_FIXTURE = Path(__file__).with_name("fixtures") / "developer_score_v1.json"


@dataclass(frozen=True, slots=True)
class BacktestCaseResult:
    name: str
    passed: bool
    score: int
    minimum: int
    maximum: int
    missing_reasons: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class BacktestReport:
    score_version: str
    fixture_version: str
    passed: int
    failed: int
    cases: tuple[BacktestCaseResult, ...]

    @property
    def all_passed(self) -> bool:
        return self.failed == 0


def _parse_datetime(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty ISO-8601 string")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{field} must include a timezone")
    return parsed


def _required_int(payload: dict[str, Any], key: str) -> int:
    value = payload.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"{key} must be a non-negative integer")
    return value


def _required_string(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty string")
    return value.strip()


def _snapshot(payload: dict[str, Any]) -> RepositorySnapshot:
    archived = payload.get("archived")
    if not isinstance(archived, bool):
        raise ValueError("archived must be a boolean")
    return RepositorySnapshot(
        name=_required_string(payload, "name"),
        full_name=_required_string(payload, "full_name"),
        url=_required_string(payload, "url"),
        stars=_required_int(payload, "stars"),
        forks=_required_int(payload, "forks"),
        watchers=_required_int(payload, "watchers"),
        contributors=_required_int(payload, "contributors"),
        commits_30d=_required_int(payload, "commits_30d"),
        issues_open=_required_int(payload, "issues_open"),
        pull_requests_open=_required_int(payload, "pull_requests_open"),
        releases=_required_int(payload, "releases"),
        archived=archived,
        created_at=_parse_datetime(payload.get("created_at"), "created_at"),
        updated_at=_parse_datetime(payload.get("updated_at"), "updated_at"),
    )


def run_developer_score_backtest(path: str | Path = DEFAULT_DEVELOPER_FIXTURE) -> BacktestReport:
    """Evaluate the current scoring version against a versioned golden fixture."""
    fixture_path = Path(path)
    try:
        payload = json.loads(fixture_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("failed to load developer score backtest fixture") from exc

    if not isinstance(payload, dict):
        raise ValueError("developer score backtest fixture must be an object")
    fixture_version = payload.get("fixture_version")
    score_version = payload.get("score_version")
    cases = payload.get("cases")
    if not isinstance(fixture_version, str) or not fixture_version:
        raise ValueError("fixture_version is required")
    if score_version != DEVELOPER_SCORE_VERSION:
        raise ValueError(
            f"fixture score_version {score_version!r} does not match {DEVELOPER_SCORE_VERSION!r}"
        )
    if not isinstance(cases, list) or not cases:
        raise ValueError("developer score backtest fixture must contain cases")

    results: list[BacktestCaseResult] = []
    seen_names: set[str] = set()
    for raw_case in cases:
        if not isinstance(raw_case, dict):
            raise ValueError("backtest case must be an object")
        name = raw_case.get("name")
        snapshot_payload = raw_case.get("snapshot")
        expected = raw_case.get("expected")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("backtest case name is required")
        name = name.strip()
        if name in seen_names:
            raise ValueError(f"duplicate backtest case name: {name}")
        seen_names.add(name)
        if not isinstance(snapshot_payload, dict) or not isinstance(expected, dict):
            raise ValueError(f"backtest case {name!r} is malformed")

        minimum = _required_int(expected, "min_score")
        maximum = _required_int(expected, "max_score")
        if minimum > maximum or maximum > 100:
            raise ValueError(f"backtest case {name!r} has invalid score bounds")
        required_reasons = expected.get("required_reasons", [])
        if not isinstance(required_reasons, list) or not all(
            isinstance(reason, str) and reason for reason in required_reasons
        ):
            raise ValueError(f"backtest case {name!r} has invalid required_reasons")

        now = _parse_datetime(raw_case.get("as_of"), "as_of")
        score = calculate_developer_score(_snapshot(snapshot_payload), now=now)
        missing = tuple(reason for reason in required_reasons if reason not in score.reasons)
        passed = minimum <= score.score <= maximum and not missing
        results.append(
            BacktestCaseResult(
                name=name,
                passed=passed,
                score=score.score,
                minimum=minimum,
                maximum=maximum,
                missing_reasons=missing,
            )
        )

    passed_count = sum(result.passed for result in results)
    return BacktestReport(
        score_version=DEVELOPER_SCORE_VERSION,
        fixture_version=fixture_version,
        passed=passed_count,
        failed=len(results) - passed_count,
        cases=tuple(results),
    )
