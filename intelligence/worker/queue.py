from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import StrEnum
from uuid import uuid4

from intelligence.errors.exceptions import QueueError


class JobStatus(StrEnum):
    CREATED = "created"
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    RETRY = "retry"


@dataclass(slots=True)
class IntelligenceJob:
    payload: dict
    id: str = field(default_factory=lambda: str(uuid4()))
    status: JobStatus = JobStatus.CREATED
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    started_at: datetime | None = None
    finished_at: datetime | None = None
    result_document_ids: list[str] = field(default_factory=list)
    error: str | None = None


class MemoryJobQueue:
    def __init__(self) -> None:
        self._jobs: dict[str, IntelligenceJob] = {}

    def submit(self, payload: dict) -> IntelligenceJob:
        if not isinstance(payload, dict):
            raise QueueError("job payload must be an object")
        job = IntelligenceJob(payload=dict(payload), status=JobStatus.QUEUED)
        self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> IntelligenceJob | None:
        return self._jobs.get(job_id)

    def update_status(self, job_id: str, status: JobStatus, error: str | None = None) -> None:
        job = self._require(job_id)
        now = datetime.now(timezone.utc)
        if status == JobStatus.RUNNING and job.started_at is None:
            job.started_at = now
        if status in {JobStatus.COMPLETED, JobStatus.FAILED}:
            job.finished_at = now
        job.status = status
        job.error = error

    def set_results(self, job_id: str, document_ids: list[str]) -> None:
        self._require(job_id).result_document_ids = list(dict.fromkeys(document_ids))

    def claim_next(self) -> IntelligenceJob | None:
        candidates = [job for job in self._jobs.values() if job.status == JobStatus.QUEUED]
        if not candidates:
            return None
        job = min(candidates, key=lambda item: (item.created_at, item.id))
        self.update_status(job.id, JobStatus.RUNNING)
        return job

    def _require(self, job_id: str) -> IntelligenceJob:
        job = self._jobs.get(job_id)
        if job is None:
            raise QueueError("intelligence job was not found")
        return job
