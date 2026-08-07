from __future__ import annotations

import contextlib
import math
from datetime import datetime, timezone
from typing import Any

from .analysis_catalog import DOMAINS
from .analysis_contracts import enrich_row, enriched_builtin
from .analysis_profiles import AnalysisProfileStore, evaluate_threshold, resolve_path, validate_threshold


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class ContractAwareAnalysisProfileStore(AnalysisProfileStore):
    def list(self, domain: str | None = None) -> list[dict[str, Any]]:
        rows = [enrich_row(row) for row in super().list(domain)]
        for row in rows:
            if row.get("custom"):
                row["contract"] = f"{row['domain']}.custom"
                row["rule_capable"] = row["type"] != "object"
            row["rule_active"] = bool(row.get("enabled") and row.get("threshold") and row.get("rule_capable"))
        rows.sort(key=lambda row: (row["domain"], row["contract"], row["runtime_state"] == "legacy", not row["enabled"], row["label"].lower()))
        return rows

    def update_builtin(self, domain: str, key: str, *, enabled: bool, threshold: str, username: str) -> dict[str, Any]:
        base = enriched_builtin(domain, key)
        if base is None:
            raise KeyError("Unknown analysis parameter")
        if base["runtime_state"] == "legacy" and enabled:
            raise ValueError("Legacy parameter cannot be enabled")
        if threshold.strip() and not base["rule_capable"]:
            raise ValueError("This parameter is display-only and cannot have a threshold")
        normalized = validate_threshold(threshold, value_type=base["type"], scale=base["scale"]) if base["rule_capable"] else ""
        self._upsert(domain, key, enabled=enabled, threshold=normalized, username=username, custom=False)
        return next(row for row in self.list(domain) if row["key"] == key)

    def update_custom(self, domain: str, key: str, *, enabled: bool, threshold: str, username: str) -> dict[str, Any]:
        row = next((item for item in self.list(domain) if item["key"] == key and item.get("custom")), None)
        if row is None:
            raise KeyError("Unknown custom analysis parameter")
        if threshold.strip() and not row["rule_capable"]:
            raise ValueError("This parameter is display-only and cannot have a threshold")
        normalized = validate_threshold(threshold, value_type=row["type"], scale=row["scale"]) if row["rule_capable"] else ""
        now = _utcnow()
        with contextlib.closing(self.connect()) as db:
            cur = db.execute(
                "UPDATE analysis_parameter_overrides SET enabled=?,threshold=?,updated_by=?,updated_at=? WHERE domain=? AND key=? AND custom=1 AND deleted=0",
                (1 if enabled else 0, normalized, username, now, domain, key),
            )
            db.commit()
            if cur.rowcount != 1:
                raise KeyError("Unknown custom analysis parameter")
        return next(item for item in self.list(domain) if item["key"] == key)

    def backtest(self, domain: str, records: list[dict[str, Any]], contract: str | None = None) -> dict[str, Any]:
        if domain not in DOMAINS:
            raise ValueError("Unknown analysis domain")
        if len(records) > 5000:
            raise ValueError("Backtest limit is 5000 records")

        all_rows = self.list(domain)
        candidates = [row for row in all_rows if row["rule_active"]]
        contracts = sorted({row["contract"] for row in candidates})
        if contract is None:
            if len(contracts) > 1:
                raise ValueError("Multiple data contracts are active; choose a backtest contract")
            contract = contracts[0] if contracts else None
        elif contract not in {row["contract"] for row in all_rows}:
            raise ValueError("Unknown backtest contract")

        params = [row for row in candidates if row["contract"] == contract]
        per_parameter = {row["key"]: {"passed": 0, "failed": 0, "missing": 0} for row in params}
        sample: list[dict[str, Any]] = []
        complete_records = strict_passed = partial_passed = evaluated_records = 0

        for index, record in enumerate(records):
            results = []
            passed = failed = missing = 0
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
            "contract": contract,
            "available_contracts": contracts,
            "records": len(records),
            "evaluated_records": evaluated_records,
            "complete_records": complete_records,
            "selected_parameters": sum(1 for row in all_rows if row["enabled"]),
            "enabled_thresholds": len(params),
            "passed_all": strict_passed,
            "pass_rate": round(strict_passed / complete_records, 6) if complete_records else None,
            "coverage": round(complete_records / len(records), 6) if records else None,
            "partial_passed": partial_passed,
            "partial_pass_rate": round(partial_passed / evaluated_records, 6) if evaluated_records else None,
            "parameters": per_parameter,
            "sample": sample,
        }
