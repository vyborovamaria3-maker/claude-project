from __future__ import annotations

from typing import Any

from .intelligence_view import IntelligenceViewStore, PostgresIntelligenceViewStore


def build_intelligence_view_store(settings: Any) -> IntelligenceViewStore | PostgresIntelligenceViewStore:
    """Build the configured read-only intelligence view without touching provider credentials."""
    backend = getattr(settings, "intelligence_backend", "sqlite")
    if backend == "postgres":
        return PostgresIntelligenceViewStore(settings.intelligence_postgres_dsn)
    if backend == "sqlite":
        return IntelligenceViewStore(settings.intelligence_db_path)
    raise ValueError("unsupported admin intelligence backend")
