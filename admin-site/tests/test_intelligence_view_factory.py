from __future__ import annotations

import unittest

from app.config import Settings
from app.intelligence_view import IntelligenceViewStore, PostgresIntelligenceViewStore
from app.intelligence_view_factory import build_intelligence_view_store


class IntelligenceViewFactoryTests(unittest.TestCase):
    def test_sqlite_backend_builds_sqlite_read_model(self) -> None:
        settings = Settings(
            environment="test",
            intelligence_backend="sqlite",
            intelligence_db_path="/tmp/intelligence.sqlite3",
        )
        store = build_intelligence_view_store(settings)
        self.assertIsInstance(store, IntelligenceViewStore)
        self.assertEqual(store.path.as_posix(), "/tmp/intelligence.sqlite3")

    def test_postgres_backend_builds_separate_read_model(self) -> None:
        settings = Settings(
            environment="test",
            intelligence_backend="postgres",
            intelligence_postgres_dsn="postgresql://readonly@db/intelligence",
        )
        store = build_intelligence_view_store(settings)
        self.assertIsInstance(store, PostgresIntelligenceViewStore)

    def test_unknown_backend_fails_closed(self) -> None:
        settings = Settings(environment="test", intelligence_backend="unknown")
        with self.assertRaises(ValueError):
            build_intelligence_view_store(settings)


if __name__ == "__main__":
    unittest.main()
