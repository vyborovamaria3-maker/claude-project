from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import StrEnum
from uuid import uuid4


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
    error: str | None = None


class MemoryJobQueue:
    def __init__(self) -> None:
        self._jobs: dict[str, IntelligenceJob] = {}

    def submit(self, payload: dict) -> IntelligenceJob:
        job = IntelligenceJob(payload=payload, status=JobStatus.QUEUED)
        self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> IntelligenceJob | None:
        return self._jobs.get(job_id)

    def update_status(self, job_id: str, status: JobStatus, error: str | None = None) -> None:
        job = self._jobs[job_id]
        job.status = status
        job.error = error
