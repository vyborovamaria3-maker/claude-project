"""Authenticated Control Center bridge to the existing local collector API."""
from __future__ import annotations
import os
from pathlib import Path
import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from typing import Literal
from .auth import require_admin

UPSTREAM = "http://127.0.0.1:3100"
API = UPSTREAM + "/api/integrations/tg-collector"

def collector_token() -> str:
    token = os.environ.get("TG_COLLECTOR_ADMIN_TOKEN", "").strip()
    if not token:
        path = Path(__file__).resolve().parents[2] / "solana-launcher" / ".env.local"
        try:
            for line in path.read_text(encoding="utf-8-sig").splitlines():
                key, sep, value = line.partition("=")
                if sep and key.strip() == "TG_COLLECTOR_ADMIN_TOKEN":
                    token = value.strip().strip("\"'")
        except OSError:
            pass
    if len(token) < 24:
        raise HTTPException(503, "Не настроено серверное подключение TG Collector")
    return token

async def upstream(method: str, *, params=None, body=None) -> dict:
    headers = {"Authorization": "Bearer " + collector_token(), "Origin": UPSTREAM}
    try:
        async with httpx.AsyncClient(timeout=15, trust_env=False, follow_redirects=False) as client:
            response = await client.request(method, API, headers=headers, params=params, json=body)
        if response.status_code != 200:
            raise HTTPException(503, "TG Collector временно недоступен")
        return response.json()
    except (httpx.HTTPError, ValueError):
        raise HTTPException(503, "Нет связи с TG Collector") from None

class ControlBody(BaseModel):
    action: Literal["start", "stop"]

def build_tg_collector_router():
    router = APIRouter(prefix="/api/tg-collector")

    @router.get("")
    async def snapshot(q: str = Query("", max_length=120), source: str | None = Query(None, pattern=r"^[1-9][0-9]{0,17}$"), page: int = Query(0, ge=0, le=100), admin=Depends(require_admin)):
        params = {"q": q, "page": page}
        if source:
            params["source"] = source
        data = await upstream("GET", params=params)
        # Never forward proxy host, credentials, sessions or unrecognised upstream fields.
        result = {key: data.get(key) for key in ("stats", "runtimeMetrics", "sources", "messages", "page", "collectionEnabled", "workerOnline", "heartbeatAt", "pausedUntil")}
        proxy = data.get("proxy") or {}
        result["proxy"] = {"enabled": proxy.get("enabled", False), "type": proxy.get("type")}
        from fastapi.responses import JSONResponse
        return JSONResponse(result, headers={"Cache-Control": "private, no-store"})

    @router.post("")
    async def control(body: ControlBody, request: Request, admin=Depends(require_admin)):
        # Require browser same-origin even in development and when used without base middleware.
        if request.headers.get("origin") != str(request.base_url).rstrip("/"):
            raise HTTPException(403, "Требуется запрос из этой админки")
        data = await upstream("POST", body={"action": body.action})
        audit = getattr(request.app.state, "audit", None)
        if audit:
            audit.record(action="tg_collector_" + body.action, success=True, username=admin["sub"], resource="tg_collector", details={})
        from fastapi.responses import JSONResponse
        return JSONResponse({"ok": True, "collectionEnabled": data.get("collectionEnabled")}, headers={"Cache-Control": "private, no-store"})

    return router
