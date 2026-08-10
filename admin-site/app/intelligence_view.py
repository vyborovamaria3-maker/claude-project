from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from .auth import require_admin


class IntelligenceViewError(RuntimeError):
    """Raised when the isolated intelligence runtime cannot be read safely."""


class IntelligenceViewStore:
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

        result: list[dict[str, Any]] = []
        for row in rows:
            result.append(
                {
                    "id": row["id"],
                    "status": row["status"],
                    "created_at": row["created_at"],
                    "started_at": row["started_at"],
                    "finished_at": row["finished_at"],
                    "result_document_ids": _safe_json_list(row["result_document_ids_json"]),
                    # Do not surface provider/query/error text through the admin read model.
                    "has_error": bool(row["error"]),
                }
            )
        return result

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

        return [
            {
                "id": row["id"],
                "source": row["source"],
                "provider": row["provider"],
                "author": row["author"],
                "published_at": row["published_at"],
                "collected_at": row["collected_at"],
                "entities": _safe_json_list(row["entities_json"]),
                "raw_hash": row["raw_hash"],
            }
            for row in rows
        ]


def _validate_limit(limit: int) -> None:
    if limit < 1 or limit > 250:
        raise ValueError("limit must be between 1 and 250")


def _safe_json_list(value: str) -> list[Any]:
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        raise IntelligenceViewError("intelligence_runtime_data_invalid") from None
    if not isinstance(parsed, list):
        raise IntelligenceViewError("intelligence_runtime_data_invalid")
    return parsed


def build_intelligence_router() -> APIRouter:
    router = APIRouter(prefix="/api/intelligence", dependencies=[Depends(require_admin)])

    def store(request: Request) -> IntelligenceViewStore:
        value = getattr(request.app.state, "intelligence_view", None)
        if not isinstance(value, IntelligenceViewStore):
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
