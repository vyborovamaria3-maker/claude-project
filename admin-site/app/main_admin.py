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
from .security_v2 import install_security
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
    app.state.analysis_profiles = LiveAnalysisProfileStore(app.state.settings.audit_db_path)
    app.state.intelligence_view = build_intelligence_view_store(app.state.settings)
    app.state.task_queue = AdminTaskQueue(
        workers=_bounded_int("ADMIN_TASK_WORKERS", 2, 1, 16),
        max_queue=_bounded_int("ADMIN_TASK_QUEUE_MAX", 32, 1, 10_000),
        max_history=_bounded_int("ADMIN_TASK_HISTORY_MAX", 500, 32, 50_000),
    )
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

    @app.middleware("http")
    async def instrument_requests(request, call_next):
        started = monotonic()
        status_code = 500
        attributes = {
            "http.request.method": request.method,
            "url.path": request.url.path,
        }
        with app.state.observability.span("admin.http.request", attributes=attributes):
            try:
                response = await call_next(request)
                status_code = response.status_code
                return response
            finally:
                app.state.observability.record_request(
                    method=request.method,
                    path=request.url.path,
                    status_code=status_code,
                    duration_seconds=monotonic() - started,
                )

    @app.get("/api/ready")
    def readiness(response: Response) -> dict[str, object]:
        checks: dict[str, bool] = {"task_queue": app.state.task_queue.ready()}
        try:
            with contextlib.closing(sqlite3.connect(app.state.settings.audit_db_path, timeout=1.0)) as db:
                row = db.execute("SELECT 1").fetchone()
                checks["audit_db"] = bool(row and row[0] == 1)
        except sqlite3.Error:
            checks["audit_db"] = False
        ready = all(checks.values())
        if not ready:
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"ready": ready, "checks": checks}

    @app.get("/metrics", include_in_schema=False)
    def prometheus_metrics() -> Response:
        payload = app.state.observability.render_prometheus(queue_metrics=app.state.task_queue.metrics)
        return Response(content=payload, media_type="text/plain; version=0.0.4; charset=utf-8")

    app.include_router(build_analysis_router())
    app.include_router(build_analysis_editor_router())
    app.include_router(build_intelligence_router())
    install_security(app)
    return app


app = create_app()
