"""PostgreSQL-backed durable intelligence job queue."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from intelligence.errors.exceptions import QueueError
from intelligence.worker.queue import IntelligenceJob, JobStatus, validate_transition


_SELECT_COLUMNS = """
id, payload_json, status, created_at, started_at, finished_at,
result_document_ids_json, error
""".strip()


class PostgresJobQueue:
    """JobQueue implementation supporting multi-worker claims with SKIP LOCKED."""

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
        """Connections are short-lived; retained for runtime lifecycle compatibility."""

    def submit(self, payload: dict) -> IntelligenceJob:
        if not isinstance(payload, dict):
            raise QueueError("job payload must be an object")
        job = IntelligenceJob(payload=dict(payload), status=JobStatus.QUEUED)
        try:
            with self._connect() as connection:
                row = connection.execute(
                    f"""
                    INSERT INTO intelligence_jobs (
                        id, payload_json, status, created_at, result_document_ids_json
                    ) VALUES (%s, %s, %s, %s, %s)
                    RETURNING {_SELECT_COLUMNS}
                    """,
                    (
                        job.id,
                        Jsonb(job.payload),
                        job.status.value,
                        job.created_at,
                        Jsonb([]),
                    ),
                ).fetchone()
            if row is None:
                raise QueueError("PostgreSQL job insert returned no row")
            return _row_to_job(row)
        except QueueError:
            raise
        except (psycopg.Error, TypeError, ValueError) as exc:
            raise QueueError("failed to submit PostgreSQL intelligence job") from exc

    def get(self, job_id: str) -> IntelligenceJob | None:
        try:
            with self._connect() as connection:
                row = connection.execute(
                    f"SELECT {_SELECT_COLUMNS} FROM intelligence_jobs WHERE id = %s",
                    (job_id,),
                ).fetchone()
            return _row_to_job(row) if row is not None else None
        except QueueError:
            raise
        except psycopg.Error as exc:
            raise QueueError("failed to read PostgreSQL intelligence job") from exc

    def update_status(self, job_id: str, status: JobStatus, error: str | None = None) -> None:
        if not isinstance(status, JobStatus):
            raise QueueError("invalid intelligence job status")
        try:
            with self._connect() as connection:
                locked = connection.execute(
                    "SELECT status FROM intelligence_jobs WHERE id = %s FOR UPDATE",
                    (job_id,),
                ).fetchone()
                if locked is None:
                    raise QueueError("intelligence job was not found")
                current_raw = locked.get("status") if isinstance(locked, dict) else None
                try:
                    current = JobStatus(current_raw)
                except (TypeError, ValueError) as exc:
                    raise QueueError("stored intelligence job status is invalid") from exc

                validate_transition(current, status)
                if current == status:
                    return

                now = datetime.now(timezone.utc)
                if status == JobStatus.RUNNING:
                    values = (status.value, now, error, job_id, current.value)
                    query = """
                        UPDATE intelligence_jobs
                        SET status = %s, started_at = COALESCE(started_at, %s), error = %s
                        WHERE id = %s AND status = %s
                    """
                elif status in {JobStatus.COMPLETED, JobStatus.FAILED}:
                    values = (status.value, now, error, job_id, current.value)
                    query = """
                        UPDATE intelligence_jobs
                        SET status = %s, finished_at = %s, error = %s
                        WHERE id = %s AND status = %s
                    """
                elif status == JobStatus.RETRY:
                    values = (status.value, error, job_id, current.value)
                    query = """
                        UPDATE intelligence_jobs
                        SET status = %s, finished_at = NULL, error = %s
                        WHERE id = %s AND status = %s
                    """
                else:
                    values = (status.value, error, job_id, current.value)
                    query = """
                        UPDATE intelligence_jobs
                        SET status = %s, error = %s
                        WHERE id = %s AND status = %s
                    """

                cursor = connection.execute(query, values)
                if cursor.rowcount != 1:
                    raise QueueError("intelligence job status changed concurrently")
        except QueueError:
            raise
        except psycopg.Error as exc:
            raise QueueError("failed to update PostgreSQL intelligence job status") from exc

    def set_results(self, job_id: str, document_ids: list[str]) -> None:
        if not isinstance(document_ids, list) or not all(isinstance(item, str) for item in document_ids):
            raise QueueError("intelligence job result IDs must be strings")
        unique_ids = list(dict.fromkeys(document_ids))
        try:
            with self._connect() as connection:
                row = connection.execute(
                    """
                    UPDATE intelligence_jobs
                    SET result_document_ids_json = %s
                    WHERE id = %s AND status IN (%s, %s)
                    RETURNING id
                    """,
                    (
                        Jsonb(unique_ids),
                        job_id,
                        JobStatus.RUNNING.value,
                        JobStatus.COMPLETED.value,
                    ),
                ).fetchone()
                if row is None:
                    raise QueueError("results require a running or completed intelligence job")
        except QueueError:
            raise
        except (psycopg.Error, TypeError, ValueError) as exc:
            raise QueueError("failed to persist PostgreSQL intelligence job results") from exc

    def claim_next(self) -> IntelligenceJob | None:
        try:
            with self._connect() as connection:
                row = connection.execute(
                    f"""
                    SELECT {_SELECT_COLUMNS}
                    FROM intelligence_jobs
                    WHERE status = %s
                    ORDER BY created_at ASC, id ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                    """,
                    (JobStatus.QUEUED.value,),
                ).fetchone()
                if row is None:
                    return None

                job_id = _required_string(row, "id")
                now = datetime.now(timezone.utc)
                claimed = connection.execute(
                    f"""
                    UPDATE intelligence_jobs
                    SET status = %s,
                        started_at = COALESCE(started_at, %s),
                        error = NULL
                    WHERE id = %s AND status = %s
                    RETURNING {_SELECT_COLUMNS}
                    """,
                    (
                        JobStatus.RUNNING.value,
                        now,
                        job_id,
                        JobStatus.QUEUED.value,
                    ),
                ).fetchone()
                if claimed is None:
                    raise QueueError("intelligence job status changed concurrently")
                return _row_to_job(claimed)
        except QueueError:
            raise
        except psycopg.Error as exc:
            raise QueueError("failed to claim PostgreSQL intelligence job") from exc

    def _connect(self) -> Any:
        try:
            return self._connect_factory(self._dsn, row_factory=dict_row)
        except psycopg.Error as exc:
            raise QueueError("failed to connect to PostgreSQL intelligence queue") from exc


def _required_string(row: dict[str, Any], key: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value:
        raise QueueError(f"PostgreSQL intelligence job has invalid {key}")
    return value


def _optional_string(row: dict[str, Any], key: str) -> str | None:
    value = row.get(key)
    if value is not None and not isinstance(value, str):
        raise QueueError(f"PostgreSQL intelligence job has invalid {key}")
    return value


def _row_to_job(row: Any) -> IntelligenceJob:
    if not isinstance(row, dict):
        raise QueueError("PostgreSQL intelligence job row has an unexpected shape")

    payload = row.get("payload_json")
    result_ids = row.get("result_document_ids_json")
    created_at = row.get("created_at")
    started_at = row.get("started_at")
    finished_at = row.get("finished_at")

    if not isinstance(payload, dict):
        raise QueueError("PostgreSQL intelligence job payload has an unexpected shape")
    if not isinstance(result_ids, list) or not all(isinstance(item, str) for item in result_ids):
        raise QueueError("PostgreSQL intelligence job result IDs are invalid")
    if not isinstance(created_at, datetime):
        raise QueueError("PostgreSQL intelligence job created_at is invalid")
    if started_at is not None and not isinstance(started_at, datetime):
        raise QueueError("PostgreSQL intelligence job started_at is invalid")
    if finished_at is not None and not isinstance(finished_at, datetime):
        raise QueueError("PostgreSQL intelligence job finished_at is invalid")

    status_raw = row.get("status")
    try:
        status = JobStatus(status_raw)
    except (TypeError, ValueError) as exc:
        raise QueueError("PostgreSQL intelligence job status is invalid") from exc

    return IntelligenceJob(
        id=_required_string(row, "id"),
        payload=dict(payload),
        status=status,
        created_at=created_at,
        started_at=started_at,
        finished_at=finished_at,
        result_document_ids=list(result_ids),
        error=_optional_string(row, "error"),
    )
