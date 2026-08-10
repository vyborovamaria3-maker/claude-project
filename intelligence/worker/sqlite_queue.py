"""SQLite-backed durable intelligence job queue."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from intelligence.errors.exceptions import QueueError
from intelligence.worker.queue import IntelligenceJob, JobStatus, validate_transition


_SCHEMA = """
CREATE TABLE IF NOT EXISTS intelligence_jobs (
    id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    result_document_ids_json TEXT NOT NULL DEFAULT '[]',
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_intelligence_jobs_status_created
    ON intelligence_jobs(status, created_at ASC, id ASC);
"""


class SQLiteJobQueue:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        try:
            if self.path != Path(":memory:"):
                self.path.parent.mkdir(parents=True, exist_ok=True)
            self._connection = sqlite3.connect(str(self.path), timeout=5.0)
            self._connection.row_factory = sqlite3.Row
            self._connection.executescript(_SCHEMA)
            self._connection.commit()
        except (OSError, sqlite3.Error) as exc:
            raise QueueError("failed to initialize SQLite intelligence queue") from exc

    def close(self) -> None:
        self._connection.close()

    def submit(self, payload: dict) -> IntelligenceJob:
        if not isinstance(payload, dict):
            raise QueueError("job payload must be an object")
        job = IntelligenceJob(payload=dict(payload), status=JobStatus.QUEUED)
        try:
            payload_json = _json_dumps(job.payload)
            self._connection.execute(
                """
                INSERT INTO intelligence_jobs (
                    id, payload_json, status, created_at, result_document_ids_json
                ) VALUES (?, ?, ?, ?, '[]')
                """,
                (job.id, payload_json, job.status.value, job.created_at.isoformat()),
            )
            self._connection.commit()
            return job
        except sqlite3.Error as exc:
            self._connection.rollback()
            raise QueueError("failed to submit intelligence job") from exc

    def get(self, job_id: str) -> IntelligenceJob | None:
        try:
            row = self._connection.execute(
                "SELECT * FROM intelligence_jobs WHERE id = ?",
                (job_id,),
            ).fetchone()
        except sqlite3.Error as exc:
            raise QueueError("failed to read intelligence job") from exc
        return _row_to_job(row) if row is not None else None

    def update_status(self, job_id: str, status: JobStatus, error: str | None = None) -> None:
        if not isinstance(status, JobStatus):
            raise QueueError("invalid intelligence job status")
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            row = self._connection.execute(
                "SELECT status FROM intelligence_jobs WHERE id = ?",
                (job_id,),
            ).fetchone()
            if row is None:
                self._connection.rollback()
                raise QueueError("intelligence job was not found")
            try:
                current = JobStatus(row["status"])
            except ValueError as exc:
                self._connection.rollback()
                raise QueueError("stored intelligence job status is invalid") from exc
            validate_transition(current, status)

            now = datetime.now(timezone.utc).isoformat()
            if status == JobStatus.RUNNING:
                cursor = self._connection.execute(
                    """
                    UPDATE intelligence_jobs
                    SET status = ?, started_at = COALESCE(started_at, ?), error = ?
                    WHERE id = ? AND status = ?
                    """,
                    (status.value, now, error, job_id, current.value),
                )
            elif status in {JobStatus.COMPLETED, JobStatus.FAILED}:
                cursor = self._connection.execute(
                    """
                    UPDATE intelligence_jobs
                    SET status = ?, finished_at = ?, error = ?
                    WHERE id = ? AND status = ?
                    """,
                    (status.value, now, error, job_id, current.value),
                )
            elif status == JobStatus.RETRY:
                cursor = self._connection.execute(
                    """
                    UPDATE intelligence_jobs
                    SET status = ?, finished_at = NULL, error = ?
                    WHERE id = ? AND status = ?
                    """,
                    (status.value, error, job_id, current.value),
                )
            else:
                cursor = self._connection.execute(
                    """
                    UPDATE intelligence_jobs
                    SET status = ?, error = ?
                    WHERE id = ? AND status = ?
                    """,
                    (status.value, error, job_id, current.value),
                )
            if cursor.rowcount != 1:
                self._connection.rollback()
                raise QueueError("intelligence job status changed concurrently")
            self._connection.commit()
        except QueueError:
            self._safe_rollback()
            raise
        except sqlite3.Error as exc:
            self._safe_rollback()
            raise QueueError("failed to update intelligence job status") from exc

    def set_results(self, job_id: str, document_ids: list[str]) -> None:
        unique_ids = list(dict.fromkeys(document_ids))
        try:
            payload = _json_dumps(unique_ids)
            cursor = self._connection.execute(
                """
                UPDATE intelligence_jobs
                SET result_document_ids_json = ?
                WHERE id = ? AND status IN (?, ?)
                """,
                (payload, job_id, JobStatus.RUNNING.value, JobStatus.COMPLETED.value),
            )
            if cursor.rowcount != 1:
                self._connection.rollback()
                raise QueueError("results require a running or completed intelligence job")
            self._connection.commit()
        except QueueError:
            self._safe_rollback()
            raise
        except sqlite3.Error as exc:
            self._safe_rollback()
            raise QueueError("failed to persist intelligence job results") from exc

    def claim_next(self) -> IntelligenceJob | None:
        """Atomically claim the oldest queued job for a worker process."""
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            row = self._connection.execute(
                """
                SELECT * FROM intelligence_jobs
                WHERE status = ?
                ORDER BY created_at ASC, id ASC
                LIMIT 1
                """,
                (JobStatus.QUEUED.value,),
            ).fetchone()
            if row is None:
                self._connection.commit()
                return None

            now = datetime.now(timezone.utc).isoformat()
            cursor = self._connection.execute(
                """
                UPDATE intelligence_jobs
                SET status = ?, started_at = COALESCE(started_at, ?), error = NULL
                WHERE id = ? AND status = ?
                """,
                (JobStatus.RUNNING.value, now, row["id"], JobStatus.QUEUED.value),
            )
            if cursor.rowcount != 1:
                self._connection.rollback()
                return None
            self._connection.commit()
            claimed = self.get(row["id"])
            if claimed is None:
                raise QueueError("claimed intelligence job disappeared")
            return claimed
        except QueueError:
            self._safe_rollback()
            raise
        except sqlite3.Error as exc:
            self._safe_rollback()
            raise QueueError("failed to claim intelligence job") from exc

    def __enter__(self) -> "SQLiteJobQueue":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    def _safe_rollback(self) -> None:
        try:
            self._connection.rollback()
        except sqlite3.Error:
            pass


def _json_dumps(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    except (TypeError, ValueError) as exc:
        raise QueueError("intelligence job contains non-serializable JSON") from exc


def _json_loads(value: str, expected: type) -> Any:
    try:
        parsed = json.loads(value)
    except (json.JSONDecodeError, TypeError) as exc:
        raise QueueError("stored intelligence job JSON is invalid") from exc
    if not isinstance(parsed, expected):
        raise QueueError("stored intelligence job JSON has an unexpected shape")
    return parsed


def _parse_datetime(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise QueueError("stored intelligence job timestamp is invalid") from exc


def _row_to_job(row: sqlite3.Row) -> IntelligenceJob:
    created_at = _parse_datetime(row["created_at"])
    if created_at is None:
        raise QueueError("stored intelligence job has no created_at timestamp")
    try:
        status = JobStatus(row["status"])
    except ValueError as exc:
        raise QueueError("stored intelligence job status is invalid") from exc
    result_ids = _json_loads(row["result_document_ids_json"], list)
    if not all(isinstance(item, str) for item in result_ids):
        raise QueueError("stored intelligence job result IDs are invalid")
    return IntelligenceJob(
        id=row["id"],
        payload=_json_loads(row["payload_json"], dict),
        status=status,
        created_at=created_at,
        started_at=_parse_datetime(row["started_at"]),
        finished_at=_parse_datetime(row["finished_at"]),
        result_document_ids=result_ids,
        error=row["error"],
    )
