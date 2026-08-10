"""SQLite persistence backend for normalized intelligence documents."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

from intelligence.core.models import IntelligenceDocument
from intelligence.errors.exceptions import StorageError
from intelligence.storage.integrity import validate_document_integrity


_SCHEMA = """
CREATE TABLE IF NOT EXISTS intelligence_documents (
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
    raw_hash TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_intelligence_documents_source
    ON intelligence_documents(source);
CREATE INDEX IF NOT EXISTS idx_intelligence_documents_collected_at
    ON intelligence_documents(collected_at);
"""


class SQLiteDocumentStore:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        try:
            if self.path != Path(":memory:"):
                self.path.parent.mkdir(parents=True, exist_ok=True)
            self._connection = sqlite3.connect(str(self.path), timeout=5.0)
            self._connection.row_factory = sqlite3.Row
            _configure_connection(self._connection, file_backed=self.path != Path(":memory:"))
            self._connection.executescript(_SCHEMA)
            self._connection.commit()
        except (OSError, sqlite3.Error) as exc:
            raise StorageError("failed to initialize SQLite intelligence store") from exc

    def close(self) -> None:
        self._connection.close()

    def save(self, document: IntelligenceDocument) -> IntelligenceDocument:
        validate_document_integrity(document)
        if document.raw_hash:
            existing = self.find_by_hash(document.raw_hash)
            if existing is not None:
                return existing

        try:
            self._connection.execute(
                """
                INSERT INTO intelligence_documents (
                    id, source, content, collected_at, url, author, provider,
                    published_at, entities_json, metrics_json, raw_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    document.id,
                    document.source,
                    document.content,
                    document.collected_at.isoformat(),
                    document.url,
                    document.author,
                    document.provider,
                    document.published_at.isoformat() if document.published_at else None,
                    _json_dumps(document.entities),
                    _json_dumps(document.metrics),
                    document.raw_hash,
                ),
            )
            self._connection.commit()
            return document
        except sqlite3.IntegrityError as exc:
            self._connection.rollback()
            if document.raw_hash:
                existing = self.find_by_hash(document.raw_hash)
                if existing is not None:
                    return existing
            raise StorageError("intelligence document violates SQLite constraints") from exc
        except sqlite3.Error as exc:
            self._connection.rollback()
            raise StorageError("failed to save intelligence document") from exc
        except StorageError:
            self._connection.rollback()
            raise
        except (TypeError, ValueError) as exc:
            self._connection.rollback()
            raise StorageError("failed to serialize intelligence document") from exc

    def get(self, document_id: str) -> IntelligenceDocument | None:
        try:
            row = self._connection.execute(
                "SELECT * FROM intelligence_documents WHERE id = ?",
                (document_id,),
            ).fetchone()
        except sqlite3.Error as exc:
            raise StorageError("failed to read intelligence document") from exc
        return _row_to_document(row) if row is not None else None

    def list_all(self) -> list[IntelligenceDocument]:
        try:
            rows = self._connection.execute(
                "SELECT * FROM intelligence_documents ORDER BY collected_at ASC, id ASC"
            ).fetchall()
        except sqlite3.Error as exc:
            raise StorageError("failed to list intelligence documents") from exc
        return [_row_to_document(row) for row in rows]

    def list_recent(self, limit: int) -> list[IntelligenceDocument]:
        if limit < 1:
            raise ValueError("limit must be > 0")
        try:
            rows = self._connection.execute(
                """
                SELECT * FROM intelligence_documents
                ORDER BY collected_at DESC, id DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        except sqlite3.Error as exc:
            raise StorageError("failed to list recent intelligence documents") from exc
        return [_row_to_document(row) for row in rows]

    def find_by_hash(self, raw_hash: str) -> IntelligenceDocument | None:
        try:
            row = self._connection.execute(
                "SELECT * FROM intelligence_documents WHERE raw_hash = ?",
                (raw_hash,),
            ).fetchone()
        except sqlite3.Error as exc:
            raise StorageError("failed to lookup intelligence document hash") from exc
        return _row_to_document(row) if row is not None else None

    def __enter__(self) -> "SQLiteDocumentStore":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()


def _configure_connection(connection: sqlite3.Connection, *, file_backed: bool) -> None:
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA synchronous = NORMAL")
    if file_backed:
        mode = connection.execute("PRAGMA journal_mode = WAL").fetchone()
        if mode is None or str(mode[0]).lower() != "wal":
            raise sqlite3.OperationalError("failed to enable WAL mode")


def _json_dumps(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    except (TypeError, ValueError) as exc:
        raise StorageError("intelligence document contains non-serializable JSON") from exc


def _json_loads(value: str, expected: type) -> Any:
    try:
        parsed = json.loads(value)
    except (json.JSONDecodeError, TypeError) as exc:
        raise StorageError("stored intelligence JSON is invalid") from exc
    if not isinstance(parsed, expected):
        raise StorageError("stored intelligence JSON has an unexpected shape")
    return parsed


def _parse_datetime(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise StorageError("stored intelligence timestamp is invalid") from exc


def _row_to_document(row: sqlite3.Row) -> IntelligenceDocument:
    collected_at = _parse_datetime(row["collected_at"])
    if collected_at is None:
        raise StorageError("stored intelligence document has no collected_at timestamp")
    document = IntelligenceDocument(
        id=row["id"],
        source=row["source"],
        content=row["content"],
        collected_at=collected_at,
        url=row["url"],
        author=row["author"],
        provider=row["provider"],
        published_at=_parse_datetime(row["published_at"]),
        entities=_json_loads(row["entities_json"], list),
        metrics=_json_loads(row["metrics_json"], dict),
        raw_hash=row["raw_hash"],
    )
    validate_document_integrity(document)
    return document
