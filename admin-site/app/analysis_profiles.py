from __future__ import annotations

import contextlib
import math
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .analysis_catalog import CATALOG_BY_ID, DOMAINS, VALUE_TYPES, catalog_for

_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
_SOURCE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,7}$")
_THRESHOLD_RE = re.compile(r"^\s*(<=|>=|==|!=|<|>)?\s*(.+?)\s*$")
_SCALAR_RE = re.compile(r"^\$?\s*(-?\d+(?:\.\d+)?)\s*([kKmMbB])?\s*(%)?\s*$")
_DURATION_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$", re.IGNORECASE)
_VALID_SCALES = {"raw", "ratio", "percent100", "seconds", "milliseconds", "hours", "days", "millions"}


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_number(text: str, *, value_type: str, scale: str) -> float:
    raw = text.strip()
    if value_type == "duration":
        match = _DURATION_RE.fullmatch(raw)
        if not match:
            raise ValueError("Invalid duration threshold")
        number = float(match.group(1))
        unit = (match.group(2) or "s").lower()
        seconds = number * {"ms": 0.001, "s": 1.0, "m": 60.0, "h": 3600.0, "d": 86400.0}[unit]
        if scale == "milliseconds":
            return seconds * 1000.0
        if scale == "hours":
            return seconds / 3600.0
        if scale == "days":
            return seconds / 86400.0
        return seconds

    match = _SCALAR_RE.fullmatch(raw)
    if not match:
        raise ValueError("Invalid threshold value")
    number = float(match.group(1))
    suffix = (match.group(2) or "").lower()
    percent = bool(match.group(3))
    number *= {"": 1.0, "k": 1_000.0, "m": 1_000_000.0, "b": 1_000_000_000.0}[suffix]
    if value_type == "percent":
        if not percent:
            raise ValueError("Percent threshold must end with %")
        return number / 100.0 if scale == "ratio" else number
    if percent:
        raise ValueError("Unexpected percent sign in threshold")
    if scale == "millions":
        return number / 1_000_000.0 if suffix else number
    return number


def validate_threshold(expression: str, *, value_type: str, scale: str = "raw") -> str:
    expression = expression.strip()
    if not expression:
        return ""
    if scale not in _VALID_SCALES:
        raise ValueError("Invalid value scale")
    match = _THRESHOLD_RE.fullmatch(expression)
    if not match:
        raise ValueError("Invalid threshold")
    op = match.group(1) or "=="
    raw = match.group(2).strip()
    if value_type == "boolean":
        if raw.lower() not in {"true", "false"} or op not in {"==", "!="}:
            raise ValueError("Boolean threshold must be true/false")
    elif value_type in {"number", "percent", "currency", "duration", "score"}:
        _parse_number(raw, value_type=value_type, scale=scale)
    elif value_type in {"text", "timestamp"}:
        if op not in {"==", "!="}:
            raise ValueError("Text/timestamp thresholds only support == or !=")
        if len(raw) > 160:
            raise ValueError("Threshold too long")
    else:
        raise ValueError("Unknown value type")
    return f"{op} {raw}" if op != "==" or expression.lstrip().startswith(("==", "!=")) else raw


def resolve_path(payload: Any, path: str) -> Any:
    current = payload
    for part in path.split("."):
        if isinstance(current, dict):
            current = current.get(part)
        elif isinstance(current, list):
            values = []
            for item in current:
                if isinstance(item, dict) and part in item:
                    values.append(item[part])
            current = values
        else:
            return None
    return current


def _coerce_actual(value: Any, value_type: str) -> Any:
    if isinstance(value, list):
        numeric = [float(item) for item in value if isinstance(item, (int, float)) and not isinstance(item, bool) and math.isfinite(float(item))]
        return sum(numeric) / len(numeric) if numeric else None
    if value_type == "boolean":
        return value if isinstance(value, bool) else None
    if value_type in {"number", "percent", "currency", "duration", "score"}:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            return None
        return float(value)
    if value is None:
        return None
    return str(value) if value_type in {"text", "timestamp"} else value


def evaluate_threshold(actual: Any, expression: str, *, value_type: str, scale: str = "raw") -> bool | None:
    expression = expression.strip()
    if not expression:
        return None
    actual = _coerce_actual(actual, value_type)
    if actual is None:
        return None
    match = _THRESHOLD_RE.fullmatch(expression)
    if not match:
        raise ValueError("Invalid threshold")
    op = match.group(1) or "=="
    raw = match.group(2).strip()
    if value_type == "boolean":
        expected: Any = raw.lower() == "true"
    elif value_type in {"number", "percent", "currency", "duration", "score"}:
        expected = _parse_number(raw, value_type=value_type, scale=scale)
    else:
        expected = raw
    return {"<": actual < expected, "<=": actual <= expected, ">": actual > expected, ">=": actual >= expected, "==": actual == expected, "!=": actual != expected}[op]


class AnalysisProfileStore:
    def __init__(self, path: str) -> None:
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with contextlib.closing(self.connect()) as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS analysis_parameter_overrides(
                  domain TEXT NOT NULL,
                  key TEXT NOT NULL,
                  enabled INTEGER NOT NULL,
                  threshold TEXT NOT NULL DEFAULT '',
                  label TEXT,
                  source TEXT,
                  value_type TEXT,
                  scale TEXT,
                  description TEXT,
                  custom INTEGER NOT NULL DEFAULT 0,
                  deleted INTEGER NOT NULL DEFAULT 0,
                  updated_by TEXT,
                  updated_at TEXT NOT NULL,
                  PRIMARY KEY(domain,key)
                );
                CREATE INDEX IF NOT EXISTS ix_analysis_overrides_domain ON analysis_parameter_overrides(domain, deleted, enabled);
                """
            )
            db.commit()

    def connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return db

    def _overrides(self, domain: str | None = None) -> dict[tuple[str, str], dict[str, Any]]:
        query = "SELECT * FROM analysis_parameter_overrides"
        params: list[Any] = []
        if domain:
            query += " WHERE domain=?"
            params.append(domain)
        with contextlib.closing(self.connect()) as db:
            return {(row["domain"], row["key"]): dict(row) for row in db.execute(query, params)}

    def list(self, domain: str | None = None) -> list[dict[str, Any]]:
        if domain and domain not in DOMAINS:
            raise ValueError("Unknown analysis domain")
        overrides = self._overrides(domain)
        rows: list[dict[str, Any]] = []
        for base in catalog_for(domain):
            row = dict(base)
            override = overrides.get((row["domain"], row["key"]))
            row["enabled"] = row["default_enabled"]
            if override:
                row["enabled"] = bool(override["enabled"])
                row["threshold"] = override["threshold"]
                row["updated_by"] = override["updated_by"]
                row["updated_at"] = override["updated_at"]
            if row["runtime_state"] == "legacy":
                row["enabled"] = False
            rows.append(row)
        builtin = {(row["domain"], row["key"]) for row in rows}
        for (odomain, key), override in overrides.items():
            if (odomain, key) in builtin or not override["custom"] or override["deleted"]:
                continue
            rows.append({
                "domain": odomain, "key": key, "label": override["label"] or key,
                "source": override["source"] or key, "type": override["value_type"] or "number",
                "threshold": override["threshold"], "runtime_state": "available",
                "default_enabled": False, "enabled": bool(override["enabled"]),
                "scale": override["scale"] or "raw", "description": override["description"] or "",
                "project_ref": "admin/custom", "custom": True,
                "updated_by": override["updated_by"], "updated_at": override["updated_at"],
            })
        rows.sort(key=lambda row: (row["domain"], row["runtime_state"] == "legacy", not row["enabled"], row["label"].lower()))
        return rows

    def update_builtin(self, domain: str, key: str, *, enabled: bool, threshold: str, username: str) -> dict[str, Any]:
        base = CATALOG_BY_ID.get((domain, key))
        if base is None:
            raise KeyError("Unknown analysis parameter")
        if base["runtime_state"] == "legacy" and enabled:
            raise ValueError("Legacy parameter cannot be enabled")
        threshold = validate_threshold(threshold, value_type=base["type"], scale=base["scale"])
        self._upsert(domain, key, enabled=enabled, threshold=threshold, username=username, custom=False)
        return next(row for row in self.list(domain) if row["key"] == key)

    def create_custom(self, domain: str, *, key: str, label: str, source: str, value_type: str, scale: str, threshold: str, enabled: bool, description: str, username: str) -> dict[str, Any]:
        if domain not in DOMAINS:
            raise ValueError("Unknown analysis domain")
        if not _KEY_RE.fullmatch(key):
            raise ValueError("Invalid parameter key")
        if (domain, key) in CATALOG_BY_ID:
            raise ValueError("Parameter key already reserved")
        if not _SOURCE_RE.fullmatch(source):
            raise ValueError("Invalid data source path")
        if value_type not in VALUE_TYPES:
            raise ValueError("Invalid value type")
        if scale not in _VALID_SCALES:
            raise ValueError("Invalid value scale")
        if not label.strip() or len(label) > 120 or len(description) > 500:
            raise ValueError("Invalid label or description")
        threshold = validate_threshold(threshold, value_type=value_type, scale=scale)
        now = _utcnow()
        with contextlib.closing(self.connect()) as db:
            existing = db.execute("SELECT custom,deleted FROM analysis_parameter_overrides WHERE domain=? AND key=?", (domain, key)).fetchone()
            if existing and not existing["deleted"]:
                raise ValueError("Custom parameter already exists")
            db.execute(
                """INSERT INTO analysis_parameter_overrides(domain,key,enabled,threshold,label,source,value_type,scale,description,custom,deleted,updated_by,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,1,0,?,?)
                   ON CONFLICT(domain,key) DO UPDATE SET enabled=excluded.enabled, threshold=excluded.threshold,
                     label=excluded.label, source=excluded.source, value_type=excluded.value_type, scale=excluded.scale,
                     description=excluded.description, custom=1, deleted=0, updated_by=excluded.updated_by, updated_at=excluded.updated_at""",
                (domain, key, 1 if enabled else 0, threshold, label.strip(), source, value_type, scale, description.strip(), username, now),
            )
            db.commit()
        return next(row for row in self.list(domain) if row["key"] == key)

    def update_custom(self, domain: str, key: str, *, enabled: bool, threshold: str, username: str) -> dict[str, Any]:
        row = next((item for item in self.list(domain) if item["key"] == key and item.get("custom")), None)
        if row is None:
            raise KeyError("Unknown custom analysis parameter")
        threshold = validate_threshold(threshold, value_type=row["type"], scale=row["scale"])
        now = _utcnow()
        with contextlib.closing(self.connect()) as db:
            cur = db.execute(
                "UPDATE analysis_parameter_overrides SET enabled=?,threshold=?,updated_by=?,updated_at=? WHERE domain=? AND key=? AND custom=1 AND deleted=0",
                (1 if enabled else 0, threshold, username, now, domain, key),
            )
            db.commit()
            if cur.rowcount != 1:
                raise KeyError("Unknown custom analysis parameter")
        return next(item for item in self.list(domain) if item["key"] == key)

    def delete_custom(self, domain: str, key: str, username: str) -> bool:
        now = _utcnow()
        with contextlib.closing(self.connect()) as db:
            cur = db.execute(
                "UPDATE analysis_parameter_overrides SET enabled=0,deleted=1,updated_by=?,updated_at=? WHERE domain=? AND key=? AND custom=1 AND deleted=0",
                (username, now, domain, key),
            )
            db.commit()
            return cur.rowcount == 1

    def _upsert(self, domain: str, key: str, *, enabled: bool, threshold: str, username: str, custom: bool) -> None:
        now = _utcnow()
        with contextlib.closing(self.connect()) as db:
            db.execute(
                """INSERT INTO analysis_parameter_overrides(domain,key,enabled,threshold,custom,deleted,updated_by,updated_at)
                   VALUES(?,?,?,?,?,0,?,?)
                   ON CONFLICT(domain,key) DO UPDATE SET enabled=excluded.enabled, threshold=excluded.threshold,
                     custom=excluded.custom, deleted=0, updated_by=excluded.updated_by, updated_at=excluded.updated_at""",
                (domain, key, 1 if enabled else 0, threshold, 1 if custom else 0, username, now),
            )
            db.commit()

    def backtest(self, domain: str, records: list[dict[str, Any]]) -> dict[str, Any]:
        if domain not in DOMAINS:
            raise ValueError("Unknown analysis domain")
        if len(records) > 5000:
            raise ValueError("Backtest limit is 5000 records")
        params = [row for row in self.list(domain) if row["enabled"] and row["runtime_state"] != "legacy" and row["threshold"]]
        per_parameter = {row["key"]: {"passed": 0, "failed": 0, "missing": 0} for row in params}
        sample = []
        complete_records = 0
        strict_passed = 0
        partial_passed = 0
        evaluated_records = 0
        for index, record in enumerate(records):
            results = []
            passed = 0
            failed = 0
            missing = 0
            for row in params:
                actual = resolve_path(record, row["source"])
                result = evaluate_threshold(actual, row["threshold"], value_type=row["type"], scale=row["scale"])
                bucket = per_parameter[row["key"]]
                if result is None:
                    bucket["missing"] += 1
                    missing += 1
                    status = "missing"
                elif result:
                    bucket["passed"] += 1
                    passed += 1
                    status = "pass"
                else:
                    bucket["failed"] += 1
                    failed += 1
                    status = "fail"
                results.append({"key": row["key"], "actual": actual, "threshold": row["threshold"], "status": status})
            if passed + failed > 0:
                evaluated_records += 1
            if failed == 0 and passed > 0:
                partial_passed += 1
            complete = bool(params) and missing == 0
            strict_pass = complete and failed == 0
            if complete:
                complete_records += 1
                if strict_pass:
                    strict_passed += 1
            if index < 200:
                sample.append({"index": index, "complete": complete, "passed": strict_pass, "partial_pass": failed == 0 and passed > 0, "results": results})
        return {
            "domain": domain,
            "records": len(records),
            "evaluated_records": evaluated_records,
            "complete_records": complete_records,
            "enabled_thresholds": len(params),
            "passed_all": strict_passed,
            "pass_rate": round(strict_passed / complete_records, 6) if complete_records else None,
            "coverage": round(complete_records / len(records), 6) if records else None,
            "partial_passed": partial_passed,
            "partial_pass_rate": round(partial_passed / evaluated_records, 6) if evaluated_records else None,
            "parameters": per_parameter,
            "sample": sample,
        }
