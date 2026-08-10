"""PostgreSQL persistence backend for normalized intelligence documents."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from intelligence.core.models import IntelligenceDocument
from intelligence.errors.exceptions import StorageError
from intelligence.storage.integrity import validate_document_integrity


_SELECT_COLUMNS = """
id, source, content, collected_at, url, author, provider,
published_at, entities_json, metrics_json, raw_hash
""".strip()


class PostgresDocumentStore:
    """DocumentStore implementation using short-lived psycopg connections."""

    def __init__(
        self,
        dsn: str,
        *,
        connect_factory: Callable[..., Any] = psycopg.connect,
    ) -> None:
        if not isinstance(dsn, str) or not dsn.strip():
            raise ValueError("PostgreSQL DSN must be a non-empty string")
        self._dsn = dsn.strip()
        self._connect_factory = connect_factory

    def close(self) -> None:
        """Kept for runtime lifecycle compatibility; connections are per-operation."""

    def save(self, document: IntelligenceDocument) -> IntelligenceDocument:
        validate_document_integrity(document)
        try:
            with self._connect() as connection:
                row = connection.execute(
                    f"""
                    INSERT INTO intelligence_documents (
                        id, source, content, collected_at, url, author, provider,
                        published_at, entities_json, metrics_json, raw_hash
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (raw_hash) DO NOTHING
                    RETURNING {_SELECT_COLUMNS}
                    """,
                    (
                        document.id,
                        document.source,
                        document.content,
                        document.collected_at,
                        document.url,
                        document.author,
                        document.provider,
                        document.published_at,
                        Jsonb(document.entities),
                        Jsonb(document.metrics),
                        document.raw_hash,
                    ),
                ).fetchone()

                if row is not None:
                    return _row_to_document(row)

                if document.raw_hash:
                    duplicate = connection.execute(
                        f"SELECT {_SELECT_COLUMNS} FROM intelligence_documents WHERE raw_hash = %s",
                        (document.raw_hash,),
                    ).fetchone()
                    if duplicate is not None:
                        return _row_to_document(duplicate)

                raise StorageError("PostgreSQL document insert returned no row")
        except StorageError:
            raise
        except (psycopg.Error, TypeError, ValueError) as exc:
            raise StorageError("failed to save intelligence document in PostgreSQL") from exc

    def get(self, document_id: str) -> IntelligenceDocument | None:
        try:
            with self._connect() as connection:
                row = connection.execute(
                    f"SELECT {_SELECT_COLUMNS} FROM intelligence_documents WHERE id = %s",
                    (document_id,),
                ).fetchone()
            return _row_to_document(row) if row is not None else None
        except StorageError:
            raise
        except psycopg.Error as exc:
            raise StorageError("failed to read intelligence document from PostgreSQL") from exc

    def list_all(self) -> list[IntelligenceDocument]:
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    f"""
                    SELECT {_SELECT_COLUMNS}
                    FROM intelligence_documents
                    ORDER BY collected_at ASC, id ASC
                    """
                ).fetchall()
            return [_row_to_document(row) for row in rows]
        except StorageError:
            raise
        except psycopg.Error as exc:
            raise StorageError("failed to list intelligence documents from PostgreSQL") from exc

    def list_recent(self, limit: int) -> list[IntelligenceDocument]:
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise ValueError("limit must be a positive integer")
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    f"""
                    SELECT {_SELECT_COLUMNS}
                    FROM intelligence_documents
                    ORDER BY collected_at DESC, id DESC
                    LIMIT %s
                    """,
                    (limit,),
                ).fetchall()
            return [_row_to_document(row) for row in rows]
        except StorageError:
            raise
        except psycopg.Error as exc:
            raise StorageError("failed to list recent intelligence documents from PostgreSQL") from exc

    def find_by_hash(self, raw_hash: str) -> IntelligenceDocument | None:
        try:
            with self._connect() as connection:
                row = connection.execute(
                    f"SELECT {_SELECT_COLUMNS} FROM intelligence_documents WHERE raw_hash = %s",
                    (raw_hash,),
                ).fetchone()
            return _row_to_document(row) if row is not None else None
        except StorageError:
            raise
        except psycopg.Error as exc:
            raise StorageError("failed to lookup intelligence document hash in PostgreSQL") from exc

    def _connect(self) -> Any:
        try:
            return self._connect_factory(
                self._dsn,
                row_factory=dict_row,
                connect_timeout=5,
            )
        except psycopg.Error as exc:
            raise StorageError("failed to connect to PostgreSQL intelligence store") from exc


def _required_string(row: dict[str, Any], key: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value:
        raise StorageError(f"PostgreSQL intelligence row has invalid {key}")
    return value


def _optional_string(row: dict[str, Any], key: str) -> str | None:
    value = row.get(key)
    if value is not None and not isinstance(value, str):
        raise StorageError(f"PostgreSQL intelligence row has invalid {key}")
    return value


def _row_to_document(row: Any) -> IntelligenceDocument:
    if not isinstance(row, dict):
        raise StorageError("PostgreSQL intelligence row has an unexpected shape")

    entities = row.get("entities_json")
    metrics = row.get("metrics_json")
    collected_at = row.get("collected_at")
    published_at = row.get("published_at")

    if not isinstance(entities, list) or not all(isinstance(item, str) for item in entities):
        raise StorageError("PostgreSQL intelligence entities have an unexpected shape")
    if not isinstance(metrics, dict):
        raise StorageError("PostgreSQL intelligence metrics have an unexpected shape")
    if not isinstance(collected_at, datetime):
        raise StorageError("PostgreSQL intelligence collected_at is invalid")
    if published_at is not None and not isinstance(published_at, datetime):
        raise StorageError("PostgreSQL intelligence published_at is invalid")

    document = IntelligenceDocument(
        id=_required_string(row, "id"),
        source=_required_string(row, "source"),
        content=_required_string(row, "content"),
        collected_at=collected_at,
        url=_optional_string(row, "url"),
        author=_optional_string(row, "author"),
        provider=_optional_string(row, "provider"),
        published_at=published_at,
        entities=list(entities),
        metrics=dict(metrics),
        raw_hash=_optional_string(row, "raw_hash"),
    )
    validate_document_integrity(document)
    return document
