from __future__ import annotations

import ipaddress
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

import psycopg

from app.config import Settings
from app.intelligence_view import (
    IntelligenceViewError,
    IntelligenceViewStore,
    PostgresIntelligenceViewStore,
    build_intelligence_router,
)


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
        row = rows[0]
        self.assertTrue(row["has_error"])
        serialized = json.dumps(row)
        self.assertNotIn("job-secret", serialized)
        self.assertNotIn("error-secret", serialized)
        self.assertNotIn("payload", row)
        self.assertNotIn("error", row)

    def test_recent_documents_never_expose_content_url_or_metrics(self) -> None:
        row = self.store.recent_documents(10)[0]
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


class FakePgResult:
    def __init__(self, *, one: Any = None, many: list[Any] | None = None) -> None:
        self.one = one
        self.many = many or []

    def fetchone(self) -> Any:
        return self.one

    def fetchall(self) -> list[Any]:
        return list(self.many)


class FakePgConnection:
    def __init__(self, results: list[FakePgResult], *, fail_read_only: bool = False) -> None:
        self.results = list(results)
        self.calls: list[tuple[str, Any]] = []
        self.fail_read_only = fail_read_only
        self.closed = False

    def __enter__(self) -> "FakePgConnection":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    def close(self) -> None:
        self.closed = True

    def execute(self, query: str, params: Any = None) -> FakePgResult:
        self.calls.append((query, params))
        if query.strip().upper() == "SET TRANSACTION READ ONLY":
            if self.fail_read_only:
                raise psycopg.OperationalError("password=read-only-secret")
            return FakePgResult()
        if not self.results:
            raise AssertionError("unexpected PostgreSQL query")
        return self.results.pop(0)


class PgConnectFactory:
    def __init__(self, connections: list[FakePgConnection]) -> None:
        self.connections = list(connections)
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def __call__(self, dsn: str, **kwargs: Any) -> FakePgConnection:
        self.calls.append((dsn, kwargs))
        if not self.connections:
            raise AssertionError("unexpected PostgreSQL connection")
        return self.connections.pop(0)


class PostgresIntelligenceViewStoreTests(unittest.TestCase):
    def test_recent_jobs_forces_read_only_transaction_and_native_jsonb(self) -> None:
        row = {
            "id": "job-1",
            "status": "completed",
            "created_at": "2026-08-10T01:00:00+00:00",
            "started_at": "2026-08-10T01:00:01+00:00",
            "finished_at": "2026-08-10T01:00:02+00:00",
            "result_document_ids_json": ["doc-1"],
            "error": None,
        }
        connection = FakePgConnection([FakePgResult(many=[row])])
        factory = PgConnectFactory([connection])
        store = PostgresIntelligenceViewStore(
            "postgresql://readonly@db/intelligence",
            connect_factory=factory,
        )
        rows = store.recent_jobs(10)
        self.assertEqual(rows[0]["result_document_ids"], ["doc-1"])
        self.assertEqual(connection.calls[0][0].strip().upper(), "SET TRANSACTION READ ONLY")
        self.assertIn("LIMIT %s", connection.calls[1][0])
        self.assertEqual(connection.calls[1][1], (10,))
        self.assertEqual(factory.calls[0][1]["connect_timeout"], 2)
        self.assertIn("row_factory", factory.calls[0][1])

    def test_read_only_setup_failure_closes_connection_and_is_secret_safe(self) -> None:
        connection = FakePgConnection([], fail_read_only=True)
        store = PostgresIntelligenceViewStore(
            "postgresql://readonly:dsn-secret@db/intelligence",
            connect_factory=PgConnectFactory([connection]),
        )
        with self.assertRaises(IntelligenceViewError) as captured:
            store.summary()
        self.assertTrue(connection.closed)
        self.assertEqual(str(captured.exception), "intelligence_runtime_unavailable")
        self.assertNotIn("read-only-secret", str(captured.exception))
        self.assertNotIn("dsn-secret", str(captured.exception))

    def test_recent_documents_rejects_invalid_native_jsonb_shape(self) -> None:
        row = {
            "id": "doc-1",
            "source": "web",
            "provider": "jina-reader",
            "author": "example.com",
            "published_at": None,
            "collected_at": "2026-08-10T02:00:00+00:00",
            "entities_json": ["ok", 123],
            "raw_hash": "a" * 64,
        }
        connection = FakePgConnection([FakePgResult(many=[row])])
        store = PostgresIntelligenceViewStore(
            "postgresql://readonly@db/intelligence",
            connect_factory=PgConnectFactory([connection]),
        )
        with self.assertRaises(IntelligenceViewError):
            store.recent_documents(10)

    def test_postgres_connection_failure_is_generic_and_dsn_safe(self) -> None:
        class FailingFactory:
            def __call__(self, dsn: str, **kwargs: Any) -> Any:
                raise psycopg.OperationalError("password=driver-secret host=internal-db")

        store = PostgresIntelligenceViewStore(
            "postgresql://readonly:dsn-secret@internal-db/intelligence",
            connect_factory=FailingFactory(),
        )
        with self.assertRaises(IntelligenceViewError) as captured:
            store.summary()
        message = str(captured.exception)
        self.assertNotIn("driver-secret", message)
        self.assertNotIn("dsn-secret", message)
        self.assertNotIn("internal-db", message)


class IntelligenceBackendConfigTests(unittest.TestCase):
    @staticmethod
    def production_env() -> dict[str, str]:
        return {
            "ADMIN_REQUIRE_NETWORK_ALLOWLIST": "true",
            "ADMIN_REQUIRE_MFA": "true",
            "ADMIN_TOTP_SECRET": "JBSWY3DPEHPK3PXP",
            "ADMIN_REQUIRE_REAUTH": "true",
            "ADMIN_SESSION_BIND_IP": "true",
            "ADMIN_SESSION_BIND_USER_AGENT": "true",
        }

    def base_settings(self, **overrides: Any) -> Settings:
        values: dict[str, Any] = {
            "environment": "production",
            "admin_password": "",
            "admin_password_hash": "test-only-nonempty-hash",
            "session_secret": "x" * 64,
            "secure_cookie": True,
            "allowed_networks": [ipaddress.ip_network("127.0.0.0/8")],
            "allowed_origins": ["https://admin.example.com"],
            "solana_rpc_url": "https://api.mainnet-beta.solana.com",
        }
        values.update(overrides)
        return Settings(**values)

    def assert_validation_error(self, expected: str, **overrides: Any) -> None:
        with patch.dict(os.environ, self.production_env(), clear=False):
            with self.assertRaisesRegex(RuntimeError, expected):
                self.base_settings(**overrides).validate()

    def test_unknown_intelligence_backend_is_rejected(self) -> None:
        self.assert_validation_error("ADMIN_INTELLIGENCE_BACKEND", intelligence_backend="redis")

    def test_postgres_backend_requires_separate_admin_dsn(self) -> None:
        self.assert_validation_error(
            "ADMIN_INTELLIGENCE_POSTGRES_DSN",
            intelligence_backend="postgres",
            intelligence_postgres_dsn="",
        )

    def test_production_sqlite_requires_absolute_path(self) -> None:
        self.assert_validation_error(
            "ADMIN_INTELLIGENCE_DB",
            intelligence_backend="sqlite",
            intelligence_db_path="relative/intelligence.sqlite3",
        )


if __name__ == "__main__":
    unittest.main()
