from __future__ import annotations

import contextlib
from datetime import datetime, timezone
from typing import Any

from .analysis_catalog import CATALOG_BY_ID, DOMAINS, VALUE_TYPES
from .analysis_profiles import _KEY_RE, _SOURCE_RE, _VALID_SCALES, validate_threshold
from .analysis_profiles_v3 import ContractAwareAnalysisProfileStore


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class LiveAnalysisProfileStore(ContractAwareAnalysisProfileStore):
    """Contract-aware profile store with safe live editing semantics.

    Built-ins may be selected/unselected, have thresholds changed, and be hidden/restored.
    Their source/type/contract remain immutable so the admin UI cannot silently break the
    production data contract. Custom parameters may be fully edited or deleted.
    """

    def list(self, domain: str | None = None) -> list[dict[str, Any]]:
        rows = super().list(domain)
        overrides = self._overrides(domain)
        for row in rows:
            override = overrides.get((row["domain"], row["key"]))
            hidden = bool(override and override.get("deleted") and not row.get("custom"))
            row["hidden"] = hidden
            if hidden:
                row["enabled"] = False
                row["rule_active"] = False
        rows.sort(
            key=lambda row: (
                row["domain"],
                bool(row.get("hidden")),
                row["contract"],
                row["runtime_state"] == "legacy",
                not row["enabled"],
                row["label"].lower(),
            )
        )
        return rows

    def edit_custom(
        self,
        domain: str,
        key: str,
        *,
        enabled: bool,
        threshold: str,
        label: str,
        source: str,
        value_type: str,
        scale: str,
        description: str,
        username: str,
    ) -> dict[str, Any]:
        if domain not in DOMAINS:
            raise ValueError("Unknown analysis domain")
        if not _KEY_RE.fullmatch(key):
            raise ValueError("Invalid parameter key")
        current = next((row for row in self.list(domain) if row["key"] == key and row.get("custom")), None)
        if current is None:
            raise KeyError("Unknown custom analysis parameter")
        if not _SOURCE_RE.fullmatch(source):
            raise ValueError("Invalid data source path")
        if value_type not in VALUE_TYPES:
            raise ValueError("Invalid value type")
        if scale not in _VALID_SCALES:
            raise ValueError("Invalid value scale")
        if not label.strip() or len(label) > 120 or len(description) > 500:
            raise ValueError("Invalid label or description")
        if value_type == "object" and threshold.strip():
            raise ValueError("Object parameter is display-only and cannot have a threshold")
        normalized = validate_threshold(threshold, value_type=value_type, scale=scale) if value_type != "object" else ""
        now = _utcnow()
        with contextlib.closing(self.connect()) as db:
            cur = db.execute(
                """UPDATE analysis_parameter_overrides
                   SET enabled=?, threshold=?, label=?, source=?, value_type=?, scale=?, description=?,
                       updated_by=?, updated_at=?
                   WHERE domain=? AND key=? AND custom=1 AND deleted=0""",
                (
                    1 if enabled else 0,
                    normalized,
                    label.strip(),
                    source,
                    value_type,
                    scale,
                    description.strip(),
                    username,
                    now,
                    domain,
                    key,
                ),
            )
            db.commit()
            if cur.rowcount != 1:
                raise KeyError("Unknown custom analysis parameter")
        return next(row for row in self.list(domain) if row["key"] == key and row.get("custom"))

    def hide_builtin(self, domain: str, key: str, username: str) -> dict[str, Any]:
        base = CATALOG_BY_ID.get((domain, key))
        if base is None:
            raise KeyError("Unknown builtin analysis parameter")
        if domain not in DOMAINS:
            raise ValueError("Unknown analysis domain")
        current = next(row for row in self.list(domain) if row["key"] == key)
        if current.get("hidden"):
            return current
        now = _utcnow()
        with contextlib.closing(self.connect()) as db:
            db.execute(
                """INSERT INTO analysis_parameter_overrides(domain,key,enabled,threshold,custom,deleted,updated_by,updated_at)
                   VALUES(?,?,?,?,0,1,?,?)
                   ON CONFLICT(domain,key) DO UPDATE SET deleted=1, custom=0,
                     updated_by=excluded.updated_by, updated_at=excluded.updated_at""",
                (
                    domain,
                    key,
                    1 if current.get("enabled") else 0,
                    current.get("threshold", ""),
                    username,
                    now,
                ),
            )
            db.commit()
        return next(row for row in self.list(domain) if row["key"] == key)

    def restore_builtin(self, domain: str, key: str, username: str) -> dict[str, Any]:
        base = CATALOG_BY_ID.get((domain, key))
        if base is None:
            raise KeyError("Unknown builtin analysis parameter")
        now = _utcnow()
        with contextlib.closing(self.connect()) as db:
            existing = db.execute(
                "SELECT enabled,threshold FROM analysis_parameter_overrides WHERE domain=? AND key=? AND custom=0",
                (domain, key),
            ).fetchone()
            if existing:
                db.execute(
                    "UPDATE analysis_parameter_overrides SET deleted=0,updated_by=?,updated_at=? WHERE domain=? AND key=? AND custom=0",
                    (username, now, domain, key),
                )
            else:
                db.execute(
                    """INSERT INTO analysis_parameter_overrides(domain,key,enabled,threshold,custom,deleted,updated_by,updated_at)
                       VALUES(?,?,?,?,0,0,?,?)""",
                    (
                        domain,
                        key,
                        1 if base.get("default_enabled") and base.get("runtime_state") != "legacy" else 0,
                        base.get("threshold", ""),
                        username,
                        now,
                    ),
                )
            db.commit()
        return next(row for row in self.list(domain) if row["key"] == key)
