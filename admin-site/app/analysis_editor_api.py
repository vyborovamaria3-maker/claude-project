from __future__ import annotations

import logging
import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .analysis_catalog import CATALOG_BY_ID, DOMAINS
from .auth import require_admin

logger = logging.getLogger(__name__)


class EditorBody(BaseModel):
    enabled: bool
    threshold: str = Field(default="", max_length=160)
    label: str | None = Field(default=None, max_length=120)
    source: str | None = Field(default=None, max_length=160)
    value_type: str | None = Field(default=None, max_length=24)
    scale: str | None = Field(default=None, max_length=24)
    description: str | None = Field(default=None, max_length=500)


def _domain_or_404(domain: str) -> None:
    if domain not in DOMAINS:
        raise HTTPException(status_code=404, detail="Unknown analysis domain")


def _audit(request: Request, admin: dict[str, Any], action: str, resource: str, details: dict[str, Any] | None = None) -> None:
    ip = request.client.host if request.client else "unknown"
    try:
        request.app.state.audit.record(
            action=action,
            success=True,
            username=admin["sub"],
            ip_address=ip,
            resource=resource,
            details=details or {},
        )
    except sqlite3.Error:
        # Profile writes commit before audit logging. Preserve truthful API semantics:
        # a durable profile change remains a success even if the audit store is unavailable.
        logger.exception("Failed to persist admin audit event action=%s resource=%s", action, resource)


def build_analysis_editor_router() -> APIRouter:
    router = APIRouter()

    @router.patch("/api/analysis-profiles/{domain}/{key}/editor")
    def edit_parameter(domain: str, key: str, body: EditorBody, request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
        _domain_or_404(domain)
        store = request.app.state.analysis_profiles
        current = next((row for row in store.list(domain) if row["key"] == key), None)
        if current is None:
            raise HTTPException(status_code=404, detail="Unknown analysis parameter")
        try:
            if current.get("custom"):
                row = store.edit_custom(
                    domain,
                    key,
                    enabled=body.enabled,
                    threshold=body.threshold,
                    label=(body.label if body.label is not None else current["label"]),
                    source=(body.source if body.source is not None else current["source"]),
                    value_type=(body.value_type if body.value_type is not None else current["type"]),
                    scale=(body.scale if body.scale is not None else current["scale"]),
                    description=(body.description if body.description is not None else current.get("description", "")),
                    username=admin["sub"],
                )
            else:
                if any(value is not None for value in (body.label, body.source, body.value_type, body.scale, body.description)):
                    raise ValueError("System parameter schema is immutable; only selected state and threshold may be changed")
                row = store.update_builtin(domain, key, enabled=body.enabled, threshold=body.threshold, username=admin["sub"])
        except KeyError:
            raise HTTPException(status_code=404, detail="Unknown analysis parameter") from None
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        _audit(
            request,
            admin,
            "analysis_parameter_live_edit",
            f"{domain}.{key}",
            {"custom": bool(row.get("custom")), "enabled": row["enabled"], "threshold": row.get("threshold", "")},
        )
        return row

    @router.delete("/api/analysis-profiles/{domain}/{key}/entry")
    def remove_parameter(domain: str, key: str, request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
        _domain_or_404(domain)
        store = request.app.state.analysis_profiles
        current = next((row for row in store.list(domain) if row["key"] == key), None)
        if current is None:
            raise HTTPException(status_code=404, detail="Unknown analysis parameter")
        if current.get("custom"):
            if not store.delete_custom(domain, key, admin["sub"]):
                raise HTTPException(status_code=404, detail="Custom analysis parameter not found")
            _audit(request, admin, "analysis_parameter_delete", f"{domain}.{key}", {"custom": True})
            return {"ok": True, "deleted": True, "hidden": False, "custom": True}
        try:
            row = store.hide_builtin(domain, key, admin["sub"])
        except KeyError:
            raise HTTPException(status_code=404, detail="System analysis parameter not found") from None
        _audit(request, admin, "analysis_parameter_hide", f"{domain}.{key}", {"custom": False})
        return {"ok": True, "deleted": False, "hidden": True, "custom": False, "row": row}

    @router.post("/api/analysis-profiles/{domain}/{key}/restore")
    def restore_parameter(domain: str, key: str, request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
        _domain_or_404(domain)
        if (domain, key) not in CATALOG_BY_ID:
            raise HTTPException(status_code=404, detail="System analysis parameter not found")
        try:
            row = request.app.state.analysis_profiles.restore_builtin(domain, key, admin["sub"])
        except KeyError:
            raise HTTPException(status_code=404, detail="System analysis parameter not found") from None
        _audit(request, admin, "analysis_parameter_restore", f"{domain}.{key}")
        return row

    return router
