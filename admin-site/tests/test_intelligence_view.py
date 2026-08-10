from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from app.intelligence_view import IntelligenceViewError, IntelligenceViewStore, build_intelligence_router


_SCHEMA = """
CREATE TABLE intelligence_jobs (
    id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    result_document_ids_json TEXT NOT NULL,
    error TEXT
);
CREATE TABLE intelligence_documents (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    content TEXT NOT NULL,
    collected_at TEXT NOT NULL,
    url TEXT,
    author TEXT,
    provider TEXT,
    published_at TEXT,
    entities_json TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    raw_hash TEXT
);
"""


class IntelligenceViewStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.path = Path(self.temp_dir.name) / "intelligence.sqlite3"
        connection = sqlite3.connect(self.path)
        connection.executescript(_SCHEMA)
        connection.execute(
            """
            INSERT INTO intelligence_jobs (
                id, payload_json, status, created_at, started_at, finished_at,
                result_document_ids_json, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "job-1",
                json.dumps({"provider": "web", "query": "token=job-secret"}),
                "failed",
                "2026-08-10T01:00:00+00:00",
                "2026-08-10T01:00:01+00:00",
                "2026-08-10T01:00:02+00:00",
                json.dumps(["doc-1"]),
                "cookie=error-secret",
            ),
        )
        connection.execute(
            """
            INSERT INTO intelligence_documents (
                id, source, content, collected_at, url, author, provider,
                published_at, entities_json, metrics_json, raw_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "doc-1",
                "web",
                "raw content must never be exposed",
                "2026-08-10T02:00:00+00:00",
                "https://example.com/project?token=url-secret",
                "example.com",
                "jina-reader",
                None,
                json.dumps(["webpage", "example.com"]),
                json.dumps({"characters": 100, "feed_url": "https://x.test/?key=metrics-secret"}),
                "a" * 64,
            ),
        )
        connection.commit()
        connection.close()
        self.store = IntelligenceViewStore(self.path)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_summary_returns_counts_only(self) -> None:
        summary = self.store.summary()
        self.assertTrue(summary["available"])
        self.assertEqual(summary["job_total"], 1)
        self.assertEqual(summary["jobs"], {"failed": 1})
        self.assertEqual(summary["document_total"], 1)
        self.assertEqual(summary["sources"], {"web": 1})

    def test_recent_jobs_never_expose_query_or_error_text(self) -> None:
        rows = self.store.recent_jobs(10)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["id"], "job-1")
        self.assertTrue(row["has_error"])
        serialized = json.dumps(row)
        self.assertNotIn("job-secret", serialized)
        self.assertNotIn("error-secret", serialized)
        self.assertNotIn("payload", row)
        self.assertNotIn("error", row)

    def test_recent_documents_never_expose_content_url_or_metrics(self) -> None:
        rows = self.store.recent_documents(10)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["id"], "doc-1")
        serialized = json.dumps(row)
        self.assertNotIn("content", row)
        self.assertNotIn("url", row)
        self.assertNotIn("metrics", row)
        self.assertNotIn("raw content", serialized)
        self.assertNotIn("url-secret", serialized)
        self.assertNotIn("metrics-secret", serialized)

    def test_missing_database_is_unavailable(self) -> None:
        missing = IntelligenceViewStore(Path(self.temp_dir.name) / "missing.sqlite3")
        with self.assertRaises(IntelligenceViewError):
            missing.summary()

    def test_corrupt_entities_json_is_rejected(self) -> None:
        connection = sqlite3.connect(self.path)
        connection.execute(
            "UPDATE intelligence_documents SET entities_json = ? WHERE id = ?",
            ("not-json", "doc-1"),
        )
        connection.commit()
        connection.close()
        with self.assertRaises(IntelligenceViewError):
            self.store.recent_documents(10)

    def test_router_is_admin_protected_and_read_only(self) -> None:
        router = build_intelligence_router()
        paths = {route.path for route in router.routes}
        methods = {method for route in router.routes for method in route.methods}
        self.assertEqual(
            paths,
            {
                "/api/intelligence/status",
                "/api/intelligence/jobs",
                "/api/intelligence/documents",
            },
        )
        self.assertEqual(methods, {"GET"})
        self.assertEqual(len(router.dependencies), 1)


if __name__ == "__main__":
    unittest.main()
