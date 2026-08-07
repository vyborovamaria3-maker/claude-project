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
    def analysis_profiles(
        domain: str | None = Query(None),
        admin=Depends(require_admin),
    ) -> dict[str, Any]:
        if domain is not None:
            _domain_or_404(domain)
        rows = router_store(router).list(domain)
        counts = {
            name: {
                "total": sum(1 for row in rows if row["domain"] == name),
                "enabled": sum(1 for row in rows if row["domain"] == name and row["enabled"]),
                "active": sum(1 for row in rows if row["domain"] == name and row["runtime_state"] == "active"),
                "available": sum(1 for row in rows if row["domain"] == name and row["runtime_state"] == "available"),
                "legacy": sum(1 for row in rows if row["domain"] == name and row["runtime_state"] == "legacy"),
            }
            for name in sorted(DOMAINS)
        }
        return {"rows": rows, "counts": counts}

    @router.put("/api/analysis-profiles/{domain}/{key}")
    def update_analysis_parameter(
        domain: str,
        key: str,
        body: AnalysisUpdateBody,
        request: Request,
        admin=Depends(require_admin),
    ) -> dict[str, Any]:
        _domain_or_404(domain)
        try:
            row = request.app.state.analysis_profiles.update_builtin(
                domain, key, enabled=body.enabled, threshold=body.threshold, username=admin["sub"]
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        _audit(request, admin, "analysis_parameter_update", f"{domain}.{key}", {"enabled": body.enabled, "threshold": row["threshold"]})
        return row

    @router.post("/api/analysis-profiles/{domain}")
    def create_analysis_parameter(
        domain: str,
        body: AnalysisCustomBody,
        request: Request,
        admin=Depends(require_admin),
    ) -> dict[str, Any]:
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
        _audit(request, admin, "analysis_parameter_create", f"{domain}.{body.key}", {"source": body.source})
        return row

    @router.delete("/api/analysis-profiles/{domain}/{key}")
    def delete_analysis_parameter(
        domain: str,
        key: str,
        request: Request,
        admin=Depends(require_admin),
    ) -> dict[str, Any]:
        _domain_or_404(domain)
        if not request.app.state.analysis_profiles.delete_custom(domain, key, admin["sub"]):
            raise HTTPException(status_code=404, detail="Custom analysis parameter not found")
        _audit(request, admin, "analysis_parameter_delete", f"{domain}.{key}")
        return {"ok": True}

    @router.post("/api/analysis-profiles/{domain}/backtest")
    def analysis_backtest(
        domain: str,
        body: AnalysisBacktestBody,
        request: Request,
        admin=Depends(require_admin),
    ) -> dict[str, Any]:
        _domain_or_404(domain)
        try:
            result = request.app.state.analysis_profiles.backtest(domain, body.records)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        _audit(request, admin, "analysis_backtest", domain, {"records": len(body.records), "pass_rate": result["pass_rate"]})
        return result

    return router


def router_store(router: APIRouter):
    # Kept only so route declaration remains easy to unit-test without global state.
    # At runtime GET routes use the current app store via dependency injection in middleware;
    # the attribute is assigned by create_app after router creation.
    store = getattr(router, "analysis_store", None)
    if store is None:
        raise RuntimeError("Analysis router store not initialized")
    return store
