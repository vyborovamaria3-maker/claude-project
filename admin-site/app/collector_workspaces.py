"""Native admin workspaces and bounded, same-origin bridge to existing local APIs.

No browser/product cookies or credentials are copied. TG Invite uses the single
configured operator's existing product identity; its owner isolation stays upstream.
"""
from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response

from .auth import require_admin
from .tg_collector_admin import collector_token

ROOT = Path(__file__).resolve().parent / "static" / "collector-workspaces"
NO_STORE = {"Cache-Control": "private, no-store"}
logger = logging.getLogger(__name__)
MODULES = {"x-collector", "tg-collector", "tg-invite", "diagnostics", "apify", "blockchain"}
PATHS = {"x": "/api/integrations/x-collector", "tg": "/api/integrations/tg-collector", "invite": "/api/tginvite", "teragram": "/api/v1/telegram/teragram", "apify": "/api/integrations/apify", "blockchain": "/api/blockchain/settings", "rpc": "/api/rpc-health", "market": "/api/market-overview", "trending": "/api/trending"}
SUFFIXES = {
    "apify": {"", "sandbox", "pumpfun-sync"},
    "blockchain": {""}, "rpc": {""}, "market": {""}, "trending": {""},
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

    @router.get("/api/collector-connections")
    async def connections(admin=Depends(require_admin)):
        """Read-only probes; never start workers, login, scan, invite or publish."""
        results = {}
        for name, family, suffix in (("xCollector", "x", ""), ("tgCollector", "tg", ""), ("tgInvite", "invite", "identity"), ("teraGram", "teragram", "status")):
            try:
                # Use the exact bridge contract, including upstream identity checks.
                scope = {"type": "http", "method": "GET", "scheme": "http", "path": "/api/collector-connections", "query_string": b"", "headers": [], "server": ("localhost", 80)}
                async def receive():
                    return {"type": "http.request", "body": b"", "more_body": False}
                result = await relay(Request(scope, receive), family, suffix, admin)
                import json
                payload = json.loads(result.body)
                valid = isinstance(payload, dict)
                if name == "xCollector":
                    valid = valid and payload.get("installed") is True and payload.get("db", {}).get("reachable") is True
                elif name == "tgCollector":
                    valid = valid and payload.get("configured") is True and isinstance(payload.get("stats"), dict)
                elif name == "tgInvite":
                    import uuid
                    try:
                        uuid.UUID(payload.get("ownerId", ""))
                    except (ValueError, TypeError, AttributeError):
                        valid = False
                results[name] = {"connected": result.status_code == 200 and valid, "status": result.status_code}
                if name == "tgCollector" and valid:
                    results[name]["workerOnline"] = payload.get("workerOnline") is True
            except HTTPException as error:
                results[name] = {"connected": False, "status": error.status_code}
            except (ValueError, TypeError, AttributeError):
                results[name] = {"connected": False, "status": 502}
        return JSONResponse({"services": results, "ready": all(item["connected"] for item in results.values())}, headers=NO_STORE)

    @router.get("/collectors/{module}")
    def workspace(module: str, request: Request, admin=Depends(require_admin)):
        if module not in MODULES:
            raise HTTPException(404)
        if request.query_params.get("embedded") != "1":
            return RedirectResponse("/#collector-" + module, status_code=307, headers=NO_STORE)
        if not (ROOT / "index.html").is_file():
            raise HTTPException(503, "Build collector workspaces before starting admin-site")
        return FileResponse(ROOT / "index.html", headers=NO_STORE)

    async def relay(request: Request, family: str, suffix: str, admin: dict):
        if suffix not in SUFFIXES[family] and not (family == "apify" and re.fullmatch(r"runs/[A-Za-z0-9_-]{1,128}", suffix)):
            raise HTTPException(404)
        if family in {"rpc", "market", "trending"} and request.method != "GET":
            raise HTTPException(405)
        mutation = request.method not in {"GET", "HEAD"}
        if mutation and (request.headers.get("origin") != str(request.base_url).rstrip("/") or request.headers.get("sec-fetch-site") == "cross-site"):
            raise HTTPException(403, "Same-origin admin request required")
        session_probe = family == "tg" and suffix == "session"
        if session_probe:
            if request.method not in {"POST", "DELETE"}:
                raise HTTPException(405)
            if request.method == "DELETE":
                return JSONResponse({"connected": False}, headers=NO_STORE)
            # Verify the real guarded API before the browser claims a connection.
            suffix = ""
            mutation = False
        origin = local_origin("ADMIN_COLLECTOR_API_ORIGIN", "http://127.0.0.1:3100")
        paths = PATHS
        if family == "teragram":
            origin = local_origin("ADMIN_COLLECTOR_BACKEND_ORIGIN", "http://127.0.0.1:8000")
        headers = {"Origin": origin, "Content-Type": "application/json", "Accept": "application/json"}
        if family == "tg":
            headers["Authorization"] = "Bearer " + collector_token()
        elif family in {"x", "invite", "teragram", "apify", "blockchain"}:
            token = os.getenv("ADMIN_COLLECTOR_ACCESS_TOKEN", "").strip() if family in {"x", "apify", "blockchain"} else ""
            token = token or os.getenv("ADMIN_TGINVITE_ACCESS_TOKEN", "").strip()
            # Local development retains its existing X tools. Production X
            # verifies this explicit operator identity upstream on every call.
            if family in {"invite", "teragram"} and not token:
                raise HTTPException(503, "Configure ADMIN_TGINVITE_ACCESS_TOKEN for the existing operator identity")
            if token:
                headers["Authorization"] = "Bearer " + token
        if family == "blockchain":
            headers["Content-Type"] = request.headers.get("content-type", "application/octet-stream")
        payload = bytearray()
        async for chunk in request.stream():
            payload.extend(chunk)
            if len(payload) > (16 * 1024 * 1024 if family == "blockchain" and request.query_params.get("action") == "import" else 300_000):
                raise HTTPException(413, "Request too large")
        target = origin + paths[family] + ("/" + suffix if suffix else "")
        try:
            async with httpx.AsyncClient(timeout=60, trust_env=False, follow_redirects=False) as client:
                async with client.stream("GET" if session_probe else request.method, target, params=request.query_params.multi_items(), headers=headers, content=bytes(payload) if mutation else None) as upstream:
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
        if session_probe:
            if status != 200:
                return JSONResponse({"connected": False, "error": "TG Collector connection unavailable", "upstreamStatus": status}, status_code=status if status in {401, 403, 404, 429, 503} else 502, headers=NO_STORE)
            import json
            try:
                snapshot = json.loads(content)
            except (ValueError, UnicodeDecodeError):
                raise HTTPException(502, "Invalid TG Collector response") from None
            if not isinstance(snapshot, dict) or snapshot.get("configured") is not True or not isinstance(snapshot.get("stats"), dict):
                raise HTTPException(502, "Invalid TG Collector snapshot")
            return JSONResponse({"connected": True, "workerOnline": snapshot.get("workerOnline") is True}, headers=NO_STORE)
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

    for family, base in PATHS.items():
        for route in (base, base + "/{suffix:path}"):
            router.add_api_route(route, endpoint(family), methods=["GET", "POST", "DELETE"], include_in_schema=False)
    return router
