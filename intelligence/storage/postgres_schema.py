"""Controlled PostgreSQL schema initialization for the intelligence runtime."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import psycopg

from intelligence.errors.exceptions import StorageError


DEFAULT_SCHEMA_PATH = Path(__file__).with_name("postgres_schema.sql")


def initialize_postgres_schema(
    dsn: str,
    *,
    connect_factory: Callable[..., Any] = psycopg.connect,
    schema_path: str | Path = DEFAULT_SCHEMA_PATH,
) -> None:
    """Apply idempotent CREATE TABLE/INDEX statements in one transaction."""
    if not isinstance(dsn, str) or not dsn.strip():
        raise ValueError("PostgreSQL DSN must be a non-empty string")

    try:
        sql = Path(schema_path).read_text(encoding="utf-8")
    except OSError as exc:
        raise StorageError("failed to read PostgreSQL intelligence schema") from exc

    statements = _schema_statements(sql)
    if not statements:
        raise StorageError("PostgreSQL intelligence schema is empty")

    try:
        with connect_factory(dsn.strip()) as connection:
            for statement in statements:
                connection.execute(statement)
    except StorageError:
        raise
    except psycopg.Error as exc:
        raise StorageError("failed to initialize PostgreSQL intelligence schema") from exc


def _schema_statements(sql: str) -> list[str]:
    """Split the repository-owned simple DDL file, excluding explicit txn wrappers."""
    statements: list[str] = []
    for chunk in sql.split(";"):
        statement = chunk.strip()
        if not statement:
            continue
        if statement.upper() in {"BEGIN", "COMMIT"}:
            continue
        statements.append(statement)
    return statements
