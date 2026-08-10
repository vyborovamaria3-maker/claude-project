from __future__ import annotations

from fastapi import FastAPI

from .analysis_api_v3 import build_analysis_router
from .analysis_editor import LiveAnalysisProfileStore
from .analysis_editor_api import build_analysis_editor_router
from .intelligence_view import build_intelligence_router
from .intelligence_view_factory import build_intelligence_view_store
from .main import create_app as create_base_app
from .security_v2 import install_security
from .services import TELEGRAM_TABLES


for _table in (
    "telegram_users",
    "telegram_calls",
    "telegram_channel_scores",
    "telegram_token_mentions",
):
    if _table not in TELEGRAM_TABLES:
        TELEGRAM_TABLES.append(_table)


def create_app() -> FastAPI:
    app = create_base_app()
    app.state.analysis_profiles = LiveAnalysisProfileStore(app.state.settings.audit_db_path)
    app.state.intelligence_view = build_intelligence_view_store(app.state.settings)
    app.include_router(build_analysis_router())
    app.include_router(build_analysis_editor_router())
    app.include_router(build_intelligence_router())
    install_security(app)
    return app


app = create_app()
