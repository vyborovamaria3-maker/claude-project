from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from .analysis_catalog import DOMAINS
from .auth import require_admin


class AnalysisUpdateBody(BaseModel):
    enabled: bool
    threshold: str = Field(default="", max_length=160)


class AnalysisCustomBody(BaseModel):
    key: str = Field(min_length=2, max_length=64)
    label: str = Field(min_length=1, max_length=120)
    source: str = Field(min_length=1, max_length=160)
    value_type: str = Field(default="number", max_length=24)
    scale: str = Field(default="raw", max_length=24)
    threshold: str = Field(default="", max_length=160)
    enabled: bool = True
    description: str = Field(default="", max_length=500)


class AnalysisBacktestBody(BaseModel):
    records: list[dict[str, Any]] = Field(default_factory=list, max_length=5000)
    contract: str | None = Field(default=None, max_length=120)


def _domain_or_404(domain: str) -> str:
    if domain not in DOMAINS:
        raise HTTPException(status_code=404, detail="Unknown analysis domain")
    return domain


def _audit(request: Request, admin: dict[str, Any], action: str, resource: str, details: dict[str, Any] | None = None) -> None:
    ip = request.client.host if request.client else "unknown"
    request.app.state.audit.record(
        action=action,
        success=True,
        username=admin["sub"],
        ip_address=ip,
        resource=resource,
        details=details or {},
    )


def build_analysis_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/analysis-profiles")
    def analysis_profiles(request: Request, domain: str | None = Query(None), admin=Depends(require_admin)) -> dict[str, Any]:
        if domain is not None:
            _domain_or_404(domain)
        rows = request.app.state.analysis_profiles.list(domain)
        counts = {}
        for name in sorted(DOMAINS):
            domain_rows = [row for row in rows if row["domain"] == name]
            counts[name] = {
                "total": len(domain_rows),
                "selected": sum(1 for row in domain_rows if row["enabled"]),
                "rules": sum(1 for row in domain_rows if row["rule_active"]),
                "active": sum(1 for row in domain_rows if row["runtime_state"] == "active"),
                "available": sum(1 for row in domain_rows if row["runtime_state"] == "available"),
                "derived": sum(1 for row in domain_rows if row["runtime_state"] == "derived"),
                "legacy": sum(1 for row in domain_rows if row["runtime_state"] == "legacy"),
                "contracts": sorted({row["contract"] for row in domain_rows}),
            }
        return {"rows": rows, "counts": counts}

    @router.put("/api/analysis-profiles/{domain}/{key}")
    def update_analysis_parameter(domain: str, key: str, body: AnalysisUpdateBody, request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
        _domain_or_404(domain)
        store = request.app.state.analysis_profiles
        try:
            row = store.update_builtin(domain, key, enabled=body.enabled, threshold=body.threshold, username=admin["sub"])
        except KeyError:
            try:
                row = store.update_custom(domain, key, enabled=body.enabled, threshold=body.threshold, username=admin["sub"])
            except KeyError:
                raise HTTPException(status_code=404, detail="Unknown analysis parameter") from None
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc)) from None
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        _audit(request, admin, "analysis_parameter_update", f"{domain}.{key}", {"enabled": body.enabled, "threshold": row["threshold"], "contract": row["contract"]})
        return row

    @router.post("/api/analysis-profiles/{domain}")
    def create_analysis_parameter(domain: str, body: AnalysisCustomBody, request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
        _domain_or_404(domain)
        try:
            row = request.app.state.analysis_profiles.create_custom(
                domain,
                key=body.key,
                label=body.label,
                source=body.source,
                value_type=body.value_type,
                scale=body.scale,
                threshold=body.threshold,
                enabled=body.enabled,
                description=body.description,
                username=admin["sub"],
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        row = next(item for item in request.app.state.analysis_profiles.list(domain) if item["key"] == body.key)
        _audit(request, admin, "analysis_parameter_create", f"{domain}.{body.key}", {"source": body.source, "contract": row["contract"]})
        return row

    @router.delete("/api/analysis-profiles/{domain}/{key}")
    def delete_analysis_parameter(domain: str, key: str, request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
        _domain_or_404(domain)
        if not request.app.state.analysis_profiles.delete_custom(domain, key, admin["sub"]):
            raise HTTPException(status_code=404, detail="Custom analysis parameter not found")
        _audit(request, admin, "analysis_parameter_delete", f"{domain}.{key}")
        return {"ok": True}

    @router.post("/api/analysis-profiles/{domain}/backtest")
    def analysis_backtest(domain: str, body: AnalysisBacktestBody, request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
        _domain_or_404(domain)
        try:
            result = request.app.state.analysis_profiles.backtest(domain, body.records, contract=body.contract)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        _audit(request, admin, "analysis_backtest", domain, {"records": len(body.records), "contract": result["contract"], "pass_rate": result["pass_rate"], "coverage": result["coverage"]})
        return result

    return router
