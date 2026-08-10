"""Queue contract for intelligence workers."""

from __future__ import annotations

from typing import Protocol

from intelligence.worker.queue import IntelligenceJob, JobStatus


class JobQueue(Protocol):
    def submit(self, payload: dict) -> IntelligenceJob:
        ...

    def get(self, job_id: str) -> IntelligenceJob | None:
        ...

    def update_status(self, job_id: str, status: JobStatus, error: str | None = None) -> None:
        ...

    def set_results(self, job_id: str, document_ids: list[str]) -> None:
        ...

    def claim_next(self) -> IntelligenceJob | None:
        """Atomically claim the oldest queued job and mark it running."""
        ...
