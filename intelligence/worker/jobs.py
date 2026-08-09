from __future__ import annotations

from intelligence.worker.queue import IntelligenceJob, JobStatus, MemoryJobQueue


class IntelligenceWorker:
    def __init__(self, queue: MemoryJobQueue) -> None:
        self.queue = queue

    async def run(self, job: IntelligenceJob) -> IntelligenceJob:
        self.queue.update_status(job.id, JobStatus.RUNNING)

        try:
            # Provider execution will be injected in the next stage.
            # Keeping this boundary explicit prevents worker/provider coupling.
            self.queue.update_status(job.id, JobStatus.COMPLETED)
        except Exception as exc:
            self.queue.update_status(job.id, JobStatus.FAILED, str(exc))

        return job
