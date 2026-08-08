from __future__ import annotations

from fastapi import FastAPI

from .analysis_api_v3 import build_analysis_router
from .analysis_editor import LiveAnalysisProfileStore
from .analysis_editor_api import build_analysis_editor_router
from .main import create_app as create_base_app


def create_app() -> FastAPI:
    app = create_base_app()
    app.state.analysis_profiles = LiveAnalysisProfileStore(app.state.settings.audit_db_path)
    app.include_router(build_analysis_router())
    app.include_router(build_analysis_editor_router())
    return app


app = create_app()
