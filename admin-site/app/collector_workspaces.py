"""Native admin workspaces and bounded, same-origin bridge to existing local APIs.

No browser/product cookies or credentials are copied. TG Invite uses the single
configured operator's existing product identity; its owner isolation stays upstream.
"""
from __future__ import annotations

import os
import logging
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from .auth import require_admin
from .tg_collector_admin import collector_token

ROOT = Path(__file__).resolve().parent / "static" / "collector-workspaces"
NO_STORE = {"Cache-Control": "private, no-store"}
logger = logging.getLogger(__name__)
MODULES = {"x-collector", "tg-collector", "tg-invite"}
SUFFIXES = {
    "x": {"", "register-session"},
    "tg": {"", "session", "discovery", "graph"},
    "invite": {"", "bot", "channels", "direct-invite", "history", "identity", "invite", "jobs", "messages", "mtproto", "source-candidates", "stats", "status"},
    "teragram": {"status", "channels", "scan/status", "scan", "scan/stop", "discovery", "verified"},
}


def local_origin(name: str, default: str) -> str:
    value = os.getenv(name, default).rstrip("/")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise HTTPException(503, f"{name} must be a loopback HTTP origin") from None
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment or port == 0:
        raise HTTPException(503, f"{name} must be a loopback HTTP origin")
    return value


def build_collector_workspaces_router():
    router = APIRouter()

    @router.get("/collectors/{module}")
    def workspace(module: str, admin=Depends(require_admin)):
        if module not in MODULES:
            raise HTTPException(404)
        if not (ROOT / "index.html").is_file():
            raise HTTPException(503, "Build collector workspaces before starting admin-site")
        return FileResponse(ROOT / "index.html", headers=NO_STORE)

    async def relay(request: Request, family: str, suffix: str, admin: dict):
        if suffix not in SUFFIXES[family]:
            raise HTTPException(404)
        mutation = request.method not in {"GET", "HEAD"}
        if mutation and (request.headers.get("origin") != str(request.base_url).rstrip("/") or request.headers.get("sec-fetch-site") == "cross-site"):
            raise HTTPException(403, "Same-origin admin request required")
        if family == "tg" and suffix == "session":
            if request.method not in {"POST", "DELETE"}:
                raise HTTPException(405)
            return JSONResponse({"connected": request.method == "POST"}, headers=NO_STORE)
        origin = local_origin("ADMIN_COLLECTOR_API_ORIGIN", "http://127.0.0.1:3100")
        paths = {"x": "/api/integrations/x-collector", "tg": "/api/integrations/tg-collector", "invite": "/api/tginvite", "teragram": "/api/v1/telegram/teragram"}
        if family == "teragram":
            origin = local_origin("ADMIN_COLLECTOR_BACKEND_ORIGIN", "http://127.0.0.1:8000")
        headers = {"Origin": origin, "Content-Type": "application/json", "Accept": "application/json"}
        if family == "tg":
            headers["Authorization"] = "Bearer " + collector_token()
        elif family in {"invite", "teragram"}:
            token = os.getenv("ADMIN_TGINVITE_ACCESS_TOKEN", "").strip()
            if not token:
                raise HTTPException(503, "Configure ADMIN_TGINVITE_ACCESS_TOKEN for the existing operator identity")
            headers["Authorization"] = "Bearer " + token
        payload = bytearray()
        async for chunk in request.stream():
            payload.extend(chunk)
            if len(payload) > 300_000:
                raise HTTPException(413, "Request too large")
        target = origin + paths[family] + ("/" + suffix if suffix else "")
        try:
            async with httpx.AsyncClient(timeout=60, trust_env=False, follow_redirects=False) as client:
                async with client.stream(request.method, target, params=request.query_params.multi_items(), headers=headers, content=bytes(payload) if mutation else None) as upstream:
                    content = bytearray()
                    async for chunk in upstream.aiter_bytes():
                        content.extend(chunk)
                        if len(content) > 5_000_000:
                            raise HTTPException(502, "Collector response too large")
                    status = upstream.status_code
                    if 300 <= status < 400:
                        raise HTTPException(502, "Unexpected collector redirect")
                    result_headers = dict(NO_STORE)
                    for key in ("retry-after",):
                        if key in upstream.headers:
                            result_headers[key] = upstream.headers[key]
        except httpx.HTTPError:
            raise HTTPException(503, "Collector service unavailable") from None
        if mutation:
            audit = getattr(request.app.state, "audit", None)
            if audit:
                try:
                    audit.record(action="collector_workspace_mutation", success=200 <= status < 300, username=admin["sub"], resource=family + "/" + suffix, details={"method": request.method, "status": status})
                except Exception:
                    # A completed external action must not become a retryable browser error.
                    logger.error("Collector workspace audit unavailable family=%s status=%s", family, status)
        return Response(bytes(content), status_code=status, media_type="application/json", headers=result_headers)

    def endpoint(family: str):
        async def call(request: Request, suffix: str = "", admin=Depends(require_admin)):
            return await relay(request, family, suffix, admin)
        return call

    for family, base in (("x", "/api/integrations/x-collector"), ("tg", "/api/integrations/tg-collector"), ("invite", "/api/tginvite"), ("teragram", "/api/v1/telegram/teragram")):
        for route in (base, base + "/{suffix:path}"):
            router.add_api_route(route, endpoint(family), methods=["GET", "POST", "DELETE"], include_in_schema=False)
    return router
