from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any

import psycopg

from intelligence.errors.exceptions import StorageError
from intelligence.storage.postgres_schema import initialize_postgres_schema


class FakeConnection:
    def __init__(self) -> None:
        self.statements: list[str] = []

    def __enter__(self) -> "FakeConnection":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        return None

    def execute(self, statement: str) -> None:
        self.statements.append(statement)


class PostgresSchemaTests(unittest.TestCase):
    def test_initializer_executes_ddl_without_nested_transaction_wrappers(self) -> None:
        connection = FakeConnection()

        def connect_factory(dsn: str) -> FakeConnection:
            self.assertEqual(dsn, "postgresql://db/intelligence")
            return connection

        initialize_postgres_schema(
            "postgresql://db/intelligence",
            connect_factory=connect_factory,
        )

        self.assertGreaterEqual(len(connection.statements), 4)
        joined = "\n".join(connection.statements)
        self.assertIn("CREATE TABLE IF NOT EXISTS intelligence_documents", joined)
        self.assertIn("CREATE TABLE IF NOT EXISTS intelligence_jobs", joined)
        self.assertNotIn("BEGIN;", joined)
        self.assertNotIn("COMMIT;", joined)

    def test_empty_schema_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "empty.sql"
            path.write_text("BEGIN; COMMIT;", encoding="utf-8")
            with self.assertRaises(StorageError):
                initialize_postgres_schema(
                    "postgresql://db/intelligence",
                    connect_factory=lambda _: FakeConnection(),
                    schema_path=path,
                )

    def test_connection_error_is_generic_and_secret_safe(self) -> None:
        def failing_factory(dsn: str) -> Any:
            raise psycopg.OperationalError("password=super-secret host=private-db")

        with self.assertRaises(StorageError) as captured:
            initialize_postgres_schema(
                "postgresql://user:dsn-secret@private-db/intelligence",
                connect_factory=failing_factory,
            )
        message = str(captured.exception)
        self.assertNotIn("super-secret", message)
        self.assertNotIn("dsn-secret", message)
        self.assertNotIn("private-db", message)

    def test_missing_schema_path_is_generic(self) -> None:
        with self.assertRaises(StorageError) as captured:
            initialize_postgres_schema(
                "postgresql://db/intelligence",
                connect_factory=lambda _: FakeConnection(),
                schema_path="/definitely/missing/intelligence.sql",
            )
        self.assertNotIn("/definitely/missing", str(captured.exception))


if __name__ == "__main__":
    unittest.main()
