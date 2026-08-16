from __future__ import annotations

import contextlib
import os
import sqlite3

from fastapi import FastAPI, Response, status

from .analysis_api_v3 import build_analysis_router
from .analysis_editor import LiveAnalysisProfileStore
from .analysis_editor_api import build_analysis_editor_router
from .intelligence_view import build_intelligence_router
from .intelligence_view_factory import build_intelligence_view_store
from .main import create_app as create_base_app
from .observability import Observability, monotonic
from .postgres_admin_state import PostgresAuditStore, PostgresControlStore, PostgresLiveAnalysisProfileStore
from .postgres_pool import build_postgres_pool
from .postgres_security_store import PostgresAdminSessionStore
from .postgres_task_queue import PostgresTaskQueue
from . import security_v2
from .services import TELEGRAM_TABLES
from .task_queue import AdminTaskQueue


for _table in (
    "telegram_users",
    "telegram_calls",
    "telegram_channel_scores",
    "telegram_token_mentions",
):
    if _table not in TELEGRAM_TABLES:
        TELEGRAM_TABLES.append(_table)


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(value, maximum))


def create_app() -> FastAPI:
    app = create_base_app()
    state_dsn = os.getenv("ADMIN_STATE_POSTGRES_DSN", "").strip()
    web_workers = _bounded_int("ADMIN_WEB_WORKERS", 1, 1, 8)
    if web_workers > 1 and not state_dsn:
        raise RuntimeError("ADMIN_STATE_POSTGRES_DSN is required when ADMIN_WEB_WORKERS > 1")

    shared_security = None
    state_pool = None
    if state_dsn:
        state_pool = build_postgres_pool(state_dsn, name="admin-state")
        app.state.postgres_state_pool = state_pool
        app.state.audit = PostgresAuditStore(state_dsn, pool=state_pool)
        app.state.control = PostgresControlStore(state_dsn, pool=state_pool)
        app.state.analysis_profiles = PostgresLiveAnalysisProfileStore(state_dsn, pool=state_pool)
        app.state.mutable_state_backend = "postgres"
    else:
        app.state.analysis_profiles = LiveAnalysisProfileStore(app.state.settings.audit_db_path)
        app.state.mutable_state_backend = "sqlite"

    app.state.intelligence_view = build_intelligence_view_store(app.state.settings)
    queue_max = _bounded_int("ADMIN_TASK_QUEUE_MAX", 32, 1, 100_000)
    history_max = max(queue_max, _bounded_int("ADMIN_TASK_HISTORY_MAX", 500, 1, 250_000))
    workers = _bounded_int("ADMIN_TASK_WORKERS", 2, 1, 16)

    if state_dsn:
        app.state.task_queue = PostgresTaskQueue(
            state_dsn,
            workers=workers,
            max_queue=queue_max,
            max_history=history_max,
        )
        app.state.task_backend = "postgres"
        shared_security = PostgresAdminSessionStore(
            state_dsn,
            ip_binding=security_v2._ip_binding,
            ua_binding=security_v2._ua_binding,
            pool=state_pool,
        )
        app.state.shared_security = shared_security
        app.state.security_backend = "postgres"
        app.state.audit.is_session_revoked = shared_security.is_revoked
        app.state.audit.revoke_session = shared_security.revoke
    else:
        app.state.task_queue = AdminTaskQueue(workers=workers, max_queue=queue_max, max_history=history_max)
        app.state.task_backend = "memory"
        app.state.security_backend = "sqlite"

    def run_analysis_backtest(payload: dict) -> dict:
        domain = str(payload.get("domain", ""))
        records = payload.get("records") or []
        contract = payload.get("contract")
        if not isinstance(records, list):
            raise ValueError("Invalid backtest payload")
        return app.state.analysis_profiles.backtest(domain, records, contract=contract)

    app.state.task_queue.register_handler("analysis_backtest", run_analysis_backtest)
    app.state.observability = Observability(
        service_name=app.state.settings.app_name,
        environment=app.state.settings.environment,
        otlp_endpoint=os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "").strip(),
    )

    @app.on_event("startup")
    def start_background_workers() -> None:
        app.state.task_queue.start()

    @app.on_event("shutdown")
    def stop_background_workers() -> None:
        app.state.task_queue.stop(timeout=5.0)
        view = getattr(app.state, "intelligence_view", None)
        close_view = getattr(view, "close", None)
        if callable(close_view):
            close_view()
        if state_pool is not None:
            state_pool.close(timeout=5.0)

    @app.middleware("http")
    async def instrument_requests(request, call_next):
        started = monotonic()
        status_code = 500
        attributes = {"http.request.method": request.method, "url.path": request.url.path}
        with app.state.observability.span("admin.http.request", attributes=attributes):
            try:
                response = await call_next(request)
                status_code = response.status_code
                return response
            finally:
                route = request.scope.get("route")
                metric_path = getattr(route, "path", request.url.path)
                app.state.observability.record_request(
                    method=request.method,
                    path=metric_path,
                    status_code=status_code,
                    duration_seconds=monotonic() - started,
                )

    @app.get("/api/ready")
    def readiness(response: Response) -> dict[str, object]:
        checks: dict[str, bool] = {"task_queue": app.state.task_queue.ready()}
        if state_dsn:
            checks["shared_security"] = app.state.shared_security.ready()
            checks["admin_state"] = app.state.audit.ready()
            checks["state_pool"] = bool(state_pool and state_pool.get_stats().get("pool_available", 0) >= 0)
        else:
            try:
                with contextlib.closing(sqlite3.connect(app.state.settings.audit_db_path, timeout=1.0)) as db:
                    row = db.execute("SELECT 1").fetchone()
                    checks["audit_db"] = bool(row and row[0] == 1)
            except sqlite3.Error:
                checks["audit_db"] = False
        ready = all(checks.values())
        if not ready:
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {
            "ready": ready,
            "checks": checks,
            "task_backend": app.state.task_backend,
            "security_backend": app.state.security_backend,
            "mutable_state_backend": app.state.mutable_state_backend,
            "web_workers": web_workers,
        }

    @app.get("/metrics", include_in_schema=False)
    def prometheus_metrics() -> Response:
        payload = app.state.observability.render_prometheus(queue_metrics=app.state.task_queue.metrics)
        return Response(content=payload, media_type="text/plain; version=0.0.4; charset=utf-8")

    app.include_router(build_analysis_router())
    app.include_router(build_analysis_editor_router())
    app.include_router(build_intelligence_router())
    if shared_security is None:
        security_v2.install_security(app)
    else:
        original_store = security_v2.AdminSessionStore
        security_v2.AdminSessionStore = lambda _path: shared_security
        try:
            security_v2.install_security(app)
        finally:
            security_v2.AdminSessionStore = original_store
    return app


app = create_app()
