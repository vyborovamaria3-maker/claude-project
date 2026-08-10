"""PostgreSQL persistence backend for normalized intelligence documents."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from intelligence.core.models import IntelligenceDocument
from intelligence.errors.exceptions import StorageError


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
            return self._connect_factory(self._dsn, row_factory=dict_row)
        except psycopg.Error as exc:
            raise StorageError("failed to connect to PostgreSQL intelligence store") from exc


def _row_to_document(row: Any) -> IntelligenceDocument:
    if not isinstance(row, dict):
        raise StorageError("PostgreSQL intelligence row has an unexpected shape")

    entities = row.get("entities_json")
    metrics = row.get("metrics_json")
    if not isinstance(entities, list) or not all(isinstance(item, str) for item in entities):
        raise StorageError("PostgreSQL intelligence entities have an unexpected shape")
    if not isinstance(metrics, dict):
        raise StorageError("PostgreSQL intelligence metrics have an unexpected shape")

    try:
        return IntelligenceDocument(
            id=str(row["id"]),
            source=str(row["source"]),
            content=str(row["content"]),
            collected_at=row["collected_at"],
            url=row.get("url"),
            author=row.get("author"),
            provider=row.get("provider"),
            published_at=row.get("published_at"),
            entities=list(entities),
            metrics=dict(metrics),
            raw_hash=row.get("raw_hash"),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise StorageError("PostgreSQL intelligence row is invalid") from exc
