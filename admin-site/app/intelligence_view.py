from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from pathlib import Path
from typing import Any

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from psycopg.rows import dict_row

from .auth import require_admin


class IntelligenceViewError(RuntimeError):
    """Raised when the isolated intelligence runtime cannot be read safely."""


class IntelligenceViewStore:
    """Read-only SQLite view used by the default single-host deployment."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    def _connect(self) -> sqlite3.Connection:
        if not self.path.is_file():
            raise IntelligenceViewError("intelligence_runtime_unavailable")
        try:
            connection = sqlite3.connect(
                f"file:{self.path}?mode=ro",
                uri=True,
                timeout=2.0,
            )
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA query_only = ON")
            connection.execute("PRAGMA busy_timeout = 2000")
            return connection
        except sqlite3.Error as exc:
            raise IntelligenceViewError("intelligence_runtime_unavailable") from exc

    def summary(self) -> dict[str, Any]:
        try:
            with self._connect() as connection:
                job_rows = connection.execute(
                    "SELECT status, COUNT(*) AS count FROM intelligence_jobs GROUP BY status"
                ).fetchall()
                source_rows = connection.execute(
                    "SELECT source, COUNT(*) AS count FROM intelligence_documents GROUP BY source"
                ).fetchall()
                latest_job = connection.execute(
                    "SELECT MAX(created_at) AS value FROM intelligence_jobs"
                ).fetchone()
                latest_document = connection.execute(
                    "SELECT MAX(collected_at) AS value FROM intelligence_documents"
                ).fetchone()
        except sqlite3.Error as exc:
            raise IntelligenceViewError("intelligence_runtime_unavailable") from exc
        return _summary_payload(job_rows, source_rows, latest_job, latest_document)

    def recent_jobs(self, limit: int) -> list[dict[str, Any]]:
        _validate_limit(limit)
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    """
                    SELECT id, status, created_at, started_at, finished_at,
                           result_document_ids_json, error
                    FROM intelligence_jobs
                    ORDER BY created_at DESC, id DESC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
        except sqlite3.Error as exc:
            raise IntelligenceViewError("intelligence_runtime_unavailable") from exc
        return [_job_payload(row, _safe_json_list(row["result_document_ids_json"])) for row in rows]

    def recent_documents(self, limit: int) -> list[dict[str, Any]]:
        _validate_limit(limit)
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    """
                    SELECT id, source, provider, author, published_at,
                           collected_at, entities_json, raw_hash
                    FROM intelligence_documents
                    ORDER BY collected_at DESC, id DESC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
        except sqlite3.Error as exc:
            raise IntelligenceViewError("intelligence_runtime_unavailable") from exc
        return [_document_payload(row, _safe_json_list(row["entities_json"])) for row in rows]


class PostgresIntelligenceViewStore:
    """Read-only PostgreSQL operational view for multi-worker deployments."""

    def __init__(
        self,
        dsn: str,
        *,
        connect_factory: Callable[..., Any] = psycopg.connect,
    ) -> None:
        if not isinstance(dsn, str) or not dsn.strip():
            raise ValueError("admin intelligence PostgreSQL DSN must be non-empty")
        self._dsn = dsn.strip()
        self._connect_factory = connect_factory

    def _connect(self) -> Any:
        connection: Any = None
        try:
            connection = self._connect_factory(
                self._dsn,
                row_factory=dict_row,
                connect_timeout=2,
            )
            # Defense in depth: the admin should also use a DB role with SELECT-only grants.
            connection.execute("SET TRANSACTION READ ONLY")
            return connection
        except psycopg.Error as exc:
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass
            raise IntelligenceViewError("intelligence_runtime_unavailable") from exc

    def summary(self) -> dict[str, Any]:
        try:
            with self._connect() as connection:
                job_rows = connection.execute(
                    "SELECT status, COUNT(*) AS count FROM intelligence_jobs GROUP BY status"
                ).fetchall()
                source_rows = connection.execute(
                    "SELECT source, COUNT(*) AS count FROM intelligence_documents GROUP BY source"
                ).fetchall()
                latest_job = connection.execute(
                    "SELECT MAX(created_at) AS value FROM intelligence_jobs"
                ).fetchone()
                latest_document = connection.execute(
                    "SELECT MAX(collected_at) AS value FROM intelligence_documents"
                ).fetchone()
        except psycopg.Error as exc:
            raise IntelligenceViewError("intelligence_runtime_unavailable") from exc
        return _summary_payload(job_rows, source_rows, latest_job, latest_document)

    def recent_jobs(self, limit: int) -> list[dict[str, Any]]:
        _validate_limit(limit)
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    """
                    SELECT id, status, created_at, started_at, finished_at,
                           result_document_ids_json, error
                    FROM intelligence_jobs
                    ORDER BY created_at DESC, id DESC
                    LIMIT %s
                    """,
                    (limit,),
                ).fetchall()
        except psycopg.Error as exc:
            raise IntelligenceViewError("intelligence_runtime_unavailable") from exc
        return [_job_payload(row, _native_string_list(row.get("result_document_ids_json"))) for row in rows]

    def recent_documents(self, limit: int) -> list[dict[str, Any]]:
        _validate_limit(limit)
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    """
                    SELECT id, source, provider, author, published_at,
                           collected_at, entities_json, raw_hash
                    FROM intelligence_documents
                    ORDER BY collected_at DESC, id DESC
                    LIMIT %s
                    """,
                    (limit,),
                ).fetchall()
        except psycopg.Error as exc:
            raise IntelligenceViewError("intelligence_runtime_unavailable") from exc
        return [_document_payload(row, _native_string_list(row.get("entities_json"))) for row in rows]


def _validate_limit(limit: int) -> None:
    if limit < 1 or limit > 250:
        raise ValueError("limit must be between 1 and 250")


def _safe_json_list(value: str) -> list[str]:
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        raise IntelligenceViewError("intelligence_runtime_data_invalid") from None
    return _native_string_list(parsed)


def _native_string_list(value: Any) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise IntelligenceViewError("intelligence_runtime_data_invalid")
    return list(value)


def _summary_payload(
    job_rows: Any,
    source_rows: Any,
    latest_job: Any,
    latest_document: Any,
) -> dict[str, Any]:
    jobs = {str(row["status"]): int(row["count"]) for row in job_rows}
    sources = {str(row["source"]): int(row["count"]) for row in source_rows}
    return {
        "available": True,
        "jobs": jobs,
        "job_total": sum(jobs.values()),
        "sources": sources,
        "document_total": sum(sources.values()),
        "latest_job_at": latest_job["value"] if latest_job else None,
        "latest_document_at": latest_document["value"] if latest_document else None,
    }


def _job_payload(row: Any, result_ids: list[str]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "status": row["status"],
        "created_at": row["created_at"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "result_document_ids": result_ids,
        # Do not surface provider/query/error text through the admin read model.
        "has_error": bool(row["error"]),
    }


def _document_payload(row: Any, entities: list[str]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "source": row["source"],
        "provider": row["provider"],
        "author": row["author"],
        "published_at": row["published_at"],
        "collected_at": row["collected_at"],
        "entities": entities,
        "raw_hash": row["raw_hash"],
    }


def build_intelligence_router() -> APIRouter:
    router = APIRouter(prefix="/api/intelligence", dependencies=[Depends(require_admin)])

    def store(request: Request) -> IntelligenceViewStore | PostgresIntelligenceViewStore:
        value = getattr(request.app.state, "intelligence_view", None)
        if not isinstance(value, (IntelligenceViewStore, PostgresIntelligenceViewStore)):
            raise HTTPException(status_code=503, detail="Intelligence runtime unavailable")
        return value

    def unavailable() -> HTTPException:
        return HTTPException(status_code=503, detail="Intelligence runtime unavailable")

    @router.get("/status")
    def intelligence_status(request: Request) -> dict[str, Any]:
        try:
            return store(request).summary()
        except IntelligenceViewError:
            raise unavailable() from None

    @router.get("/jobs")
    def intelligence_jobs(
        request: Request,
        limit: int = Query(50, ge=1, le=250),
    ) -> dict[str, Any]:
        try:
            rows = store(request).recent_jobs(limit)
        except IntelligenceViewError:
            raise unavailable() from None
        return {"rows": rows, "count": len(rows)}

    @router.get("/documents")
    def intelligence_documents(
        request: Request,
        limit: int = Query(50, ge=1, le=250),
    ) -> dict[str, Any]:
        try:
            rows = store(request).recent_documents(limit)
        except IntelligenceViewError:
            raise unavailable() from None
        return {"rows": rows, "count": len(rows)}

    return router
