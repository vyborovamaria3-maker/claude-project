from __future__ import annotations

import ipaddress
import json
import time
import re
from pathlib import Path
from typing import Any

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .audit import AuditStore
from .control import ControlStore, inventory, runtime_metrics
from .auth import LoginLimiter, check_admin_password, issue_session, require_admin
from .config import Settings
from .database import SourceRegistry
from .services import (
    BLOCKCHAIN_TABLES,
    TELEGRAM_TABLES,
    X_TABLES,
    combined_users,
    domain_tables,
    log_catalog,
    read_log,
    source_summary,
    global_search,
    relation_graph,
    queue_overview,
)

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=1, max_length=1024)


class FeatureFlagBody(BaseModel):
    name: str = Field(min_length=2, max_length=80, pattern=r"^[A-Za-z0-9_.-]+$")
    enabled: bool
    description: str = Field(default="", max_length=500)


class AlertBody(BaseModel):
    level: str = Field(default="warning", pattern="^(info|warning|error|critical)$")
    title: str = Field(min_length=2, max_length=160)
    message: str = Field(min_length=1, max_length=2000)
    source: str = Field(default="control-center", max_length=100)


_BASE58 = re.compile(r"^[1-9A-HJ-NP-Za-km-z]+$")


def _base58_decode(value: str) -> bytes:
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    number = 0
    for char in value:
        number = number * 58 + alphabet.index(char)
    raw = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    return b"\x00" * (len(value) - len(value.lstrip("1"))) + raw


class SolanaLookupBody(BaseModel):
    value: str = Field(min_length=32, max_length=128)
    mode: str = Field(default="address", pattern="^(address|signature)$")

    def validated_value(self) -> str:
        if not _BASE58.fullmatch(self.value):
            raise ValueError("Invalid base58 value")
        decoded = _base58_decode(self.value)
        expected = 64 if self.mode == "signature" else 32
        if len(decoded) != expected:
            raise ValueError(f"Invalid Solana {self.mode}")
        return self.value


def client_ip(request: Request) -> str:
    settings: Settings = request.app.state.settings
    direct = request.client.host if request.client else "unknown"
    if not settings.trust_proxy:
        return direct
    values = [item.strip() for item in request.headers.get("x-forwarded-for", "").split(",") if item.strip()]
    if not values:
        return direct
    index = len(values) - settings.trusted_proxy_hops - 1
    if index < 0:
        return direct
    candidate = values[index]
    try:
        ipaddress.ip_address(candidate)
        return candidate
    except ValueError:
        return direct


def create_app() -> FastAPI:
    settings = Settings.load()
    settings.validate()
    app = FastAPI(title=settings.app_name, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.registry = SourceRegistry(settings.sources, show_sensitive=settings.show_sensitive)
    app.state.audit = AuditStore(settings.audit_db_path)
    app.state.login_limiter = LoginLimiter()
    app.state.control = ControlStore(settings.audit_db_path)
    app.state.started_at = time.monotonic()

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            origin = request.headers.get("origin", "").rstrip("/")
            if settings.environment.lower() == "production" and not origin:
                return Response(status_code=403, content="Origin header required")
            if settings.allowed_origins:
                if origin not in set(settings.allowed_origins):
                    return Response(status_code=403, content="Cross-site request rejected")
            elif origin:
                host = request.headers.get("host", "")
                if origin not in {f"https://{host}", f"http://{host}"}:
                    return Response(status_code=403, content="Cross-site request rejected")
        if settings.allowed_networks and request.url.path != "/api/health":
            raw = client_ip(request)
            try:
                address = ipaddress.ip_address(raw)
                if not any(address in network for network in settings.allowed_networks):
                    return Response(status_code=403, content="Forbidden")
            except ValueError:
                return Response(status_code=403, content="Forbidden")
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Cache-Control"] = "no-store"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; "
            "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        )
        return response

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "service": settings.app_name}

    @app.post("/api/login")
    def login(body: LoginBody, request: Request, response: Response) -> dict[str, Any]:
        ip = client_ip(request)
        limiter: LoginLimiter = app.state.login_limiter
        if not limiter.allow(ip):
            app.state.audit.record(action="login", success=False, username=body.username, ip_address=ip, details={"reason": "rate_limited"})
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many attempts")
        if not check_admin_password(settings, body.username, body.password):
            limiter.record_failure(ip)
            app.state.audit.record(action="login", success=False, username=body.username, ip_address=ip, details={"reason": "invalid_credentials"})
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
        limiter.clear(ip)
        response.set_cookie(
            settings.session_cookie,
            issue_session(settings, body.username),
            max_age=settings.session_ttl_seconds,
            httponly=True,
            secure=settings.secure_cookie,
            samesite="strict",
            path="/",
        )
        app.state.audit.record(action="login", success=True, username=body.username, ip_address=ip)
        return {"ok": True, "username": body.username}

    @app.post("/api/logout")
    def logout(request: Request, response: Response, admin=Depends(require_admin)) -> dict[str, Any]:
        response.delete_cookie(settings.session_cookie, path="/")
        app.state.audit.record(action="logout", success=True, username=admin["sub"], ip_address=client_ip(request))
        return {"ok": True}

    @app.get("/api/me")
    def me(admin=Depends(require_admin)) -> dict[str, Any]:
        return {"authenticated": True, "username": admin["sub"], "expires_at": admin["exp"]}

    @app.get("/api/overview")
    def overview(admin=Depends(require_admin)) -> dict[str, Any]:
        registry: SourceRegistry = app.state.registry
        sources = source_summary(registry)
        users = combined_users(registry, limit_per_source=1000)
        return {
            "sources": sources,
            "total_sources": len(sources),
            "healthy_sources": sum(1 for item in sources if item["ok"]),
            "total_tables": sum(int(item["tables"]) for item in sources),
            "total_rows": sum(int(item["rows"]) for item in sources),
            "total_users": len(users),
            "logs": log_catalog(settings.logs),
        }

    @app.get("/api/sources")
    def sources(admin=Depends(require_admin)) -> dict[str, Any]:
        return {"sources": source_summary(app.state.registry)}

    @app.get("/api/sources/{source_id}/tables")
    def tables(source_id: str, admin=Depends(require_admin)) -> dict[str, Any]:
        try:
            source = app.state.registry.get(source_id)
            items = []
            for table in source.tables():
                try:
                    items.append({"name": table, "rows": source.estimate_count(table)})
                except Exception as exc:
                    items.append({"name": table, "rows": None, "error": str(exc)[:200]})
            return {"source": source_id, "tables": items}
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None

    @app.get("/api/sources/{source_id}/tables/{table}")
    def table_rows(
        source_id: str,
        table: str,
        page: int = Query(1, ge=1),
        page_size: int = Query(50, ge=1),
        sort: str | None = None,
        order: str = Query("desc", pattern="^(asc|desc)$"),
        search: str = Query("", max_length=200),
        admin=Depends(require_admin),
    ) -> dict[str, Any]:
        try:
            source = app.state.registry.get(source_id)
            return source.rows(
                table,
                page=page,
                page_size=min(page_size, settings.max_page_size),
                sort=sort,
                order=order,
                search=search,
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
        except Exception:
            raise HTTPException(status_code=503, detail="Data source unavailable") from None

    @app.get("/api/sources/{source_id}/tables/{table}/export.csv")
    def export_table(
        source_id: str,
        table: str,
        request: Request,
        limit: int = Query(5000, ge=1),
        admin=Depends(require_admin),
    ) -> StreamingResponse:
        export_limit = min(limit, settings.max_export_rows)
        try:
            source = app.state.registry.get(source_id)
            # Validate the table before sending response headers; iteration itself is lazy.
            source.columns(table)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
        except Exception:
            raise HTTPException(status_code=503, detail="Data source unavailable") from None

        ip = client_ip(request)

        def stream_csv():
            try:
                yield from source.iter_csv(table, limit=export_limit)
                app.state.audit.record(
                    action="export_table",
                    success=True,
                    username=admin["sub"],
                    ip_address=ip,
                    resource=f"{source_id}.{table}",
                    details={"limit": export_limit, "streamed": True},
                )
            except Exception as exc:
                app.state.audit.record(
                    action="export_table",
                    success=False,
                    username=admin["sub"],
                    ip_address=ip,
                    resource=f"{source_id}.{table}",
                    details={"limit": export_limit, "streamed": True, "error": str(exc)[:200]},
                )
                raise

        return StreamingResponse(
            stream_csv(),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{source_id}-{table}.csv"'},
        )

    @app.get("/api/users")
    def users(limit: int = Query(500, ge=1, le=5000), admin=Depends(require_admin)) -> dict[str, Any]:
        rows = combined_users(app.state.registry, limit_per_source=limit)
        return {"total": len(rows), "rows": rows[:limit]}

    @app.get("/api/blockchain")
    def blockchain(limit: int = Query(100, ge=1, le=500), admin=Depends(require_admin)) -> dict[str, Any]:
        return domain_tables(app.state.registry, BLOCKCHAIN_TABLES, limit=limit)

    @app.get("/api/social/x")
    def social_x(limit: int = Query(100, ge=1, le=500), admin=Depends(require_admin)) -> dict[str, Any]:
        return domain_tables(app.state.registry, X_TABLES, limit=limit)

    @app.get("/api/social/telegram")
    def social_telegram(limit: int = Query(100, ge=1, le=500), admin=Depends(require_admin)) -> dict[str, Any]:
        data = domain_tables(app.state.registry, TELEGRAM_TABLES, limit=limit)
        data["users"] = [row for row in combined_users(app.state.registry, limit_per_source=limit) if row.get("telegram_id") or row.get("telegram_username")]
        return data

    @app.get("/api/logs")
    def logs(log_id: str | None = None, lines: int = Query(300, ge=1, le=5000), search: str = Query("", max_length=200), admin=Depends(require_admin)) -> dict[str, Any]:
        catalog = log_catalog(settings.logs)
        if not log_id:
            return {"catalog": catalog, "log": None}
        config = next((item for item in settings.logs if item.id == log_id), None)
        if config is None:
            raise HTTPException(status_code=404, detail="Unknown log source")
        return {"catalog": catalog, "log": read_log(config, lines=lines, search=search)}

    @app.get("/api/search")
    def search(q: str = Query(..., min_length=2, max_length=128), admin=Depends(require_admin)) -> dict[str, Any]:
        return global_search(app.state.registry, q)

    @app.get("/api/graph")
    def graph(q: str = Query(..., min_length=2, max_length=128), admin=Depends(require_admin)) -> dict[str, Any]:
        return relation_graph(app.state.registry, q)

    @app.get("/api/queues")
    def queues(limit: int = Query(100, ge=1, le=500), admin=Depends(require_admin)) -> dict[str, Any]:
        return queue_overview(app.state.registry, limit=limit)

    @app.get("/api/monitoring")
    def monitoring(admin=Depends(require_admin)) -> dict[str, Any]:
        return {
            "runtime": runtime_metrics(app.state.started_at),
            "sources": source_summary(app.state.registry),
            "logs": log_catalog(settings.logs),
        }

    @app.get("/api/inventory")
    def project_inventory(admin=Depends(require_admin)) -> dict[str, Any]:
        root = BASE_DIR.parent.parent
        return inventory(root)

    @app.get("/api/feature-flags")
    def feature_flags(admin=Depends(require_admin)) -> dict[str, Any]:
        return {"rows": app.state.control.flags()}

    @app.put("/api/feature-flags/{name}")
    def update_feature_flag(name: str, body: FeatureFlagBody, request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
        if name != body.name:
            raise HTTPException(status_code=400, detail="Flag name mismatch")
        row = app.state.control.set_flag(body.name, body.enabled, body.description, admin["sub"])
        app.state.audit.record(action="feature_flag_update", success=True, username=admin["sub"], ip_address=client_ip(request), resource=name, details={"enabled": body.enabled})
        return row

    @app.get("/api/alerts")
    def alerts(status_filter: str | None = Query(None, alias="status"), limit: int = Query(200, ge=1, le=1000), admin=Depends(require_admin)) -> dict[str, Any]:
        return {"rows": app.state.control.alerts(status_filter, limit)}

    @app.post("/api/alerts")
    def create_alert(body: AlertBody, request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
        row = app.state.control.create_alert(body.level, body.title, body.message, body.source)
        app.state.audit.record(action="alert_create", success=True, username=admin["sub"], ip_address=client_ip(request), resource=str(row["id"]), details={"level": body.level})
        return row

    @app.post("/api/alerts/{alert_id}/acknowledge")
    def acknowledge_alert(alert_id: int, request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
        if not app.state.control.acknowledge(alert_id, admin["sub"]):
            raise HTTPException(status_code=404, detail="Open alert not found")
        app.state.audit.record(action="alert_acknowledge", success=True, username=admin["sub"], ip_address=client_ip(request), resource=str(alert_id))
        return {"ok": True}

    @app.get("/api/audit")
    def audit(limit: int = Query(200, ge=1, le=1000), admin=Depends(require_admin)) -> dict[str, Any]:
        return {"rows": app.state.audit.list(limit)}

    @app.post("/api/solana/lookup")
    async def solana_lookup(body: SolanaLookupBody, request: Request, admin=Depends(require_admin)) -> dict[str, Any]:
        try:
            value = body.validated_value()
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        method = "getTransaction" if body.mode == "signature" else "getAccountInfo"
        params = (
            [value, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}]
            if body.mode == "signature"
            else [value, {"encoding": "jsonParsed", "commitment": "confirmed"}]
        )
        payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                rpc_response = await client.post(settings.solana_rpc_url, json=payload)
                rpc_response.raise_for_status()
                data = rpc_response.json()
            app.state.audit.record(
                action="solana_lookup",
                success=True,
                username=admin["sub"],
                ip_address=client_ip(request),
                resource=value,
                details={"mode": body.mode},
            )
            return {"method": method, "value": value, "rpc": data}
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            app.state.audit.record(
                action="solana_lookup",
                success=False,
                username=admin["sub"],
                ip_address=client_ip(request),
                resource=value,
                details={"mode": body.mode, "error": str(exc)},
            )
            raise HTTPException(status_code=502, detail="Solana RPC request failed") from None

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


app = create_app()
