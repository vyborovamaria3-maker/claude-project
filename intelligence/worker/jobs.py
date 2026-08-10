from __future__ import annotations

from intelligence.errors.exceptions import IntelligenceError, JobValidationError, QueueError
from intelligence.providers.registry import ProviderRegistry
from intelligence.security.sanitizer import sanitize_text
from intelligence.storage.base import DocumentStore
from intelligence.worker.base import JobQueue
from intelligence.worker.queue import IntelligenceJob, JobStatus


class IntelligenceWorker:
    def __init__(
        self,
        queue: JobQueue,
        registry: ProviderRegistry,
        store: DocumentStore,
    ) -> None:
        self.queue = queue
        self.registry = registry
        self.store = store

    async def run(self, job: IntelligenceJob) -> IntelligenceJob:
        if job.status != JobStatus.RUNNING:
            self.queue.update_status(job.id, JobStatus.RUNNING)

        try:
            provider_name, query = _validate_payload(job.payload)
            provider = self.registry.get(provider_name)
            collected = await provider.collect(query)

            stored_ids: list[str] = []
            for document in collected:
                normalized = provider.normalize(document)
                stored = self.store.save(normalized)
                if stored.id not in stored_ids:
                    stored_ids.append(stored.id)

            self.queue.set_results(job.id, stored_ids)
            self.queue.update_status(job.id, JobStatus.COMPLETED)
        except (IntelligenceError, ValueError, TypeError) as exc:
            self._mark_failed(job.id, sanitize_text(str(exc))[:500])
        except Exception:
            # Unknown implementation errors are intentionally not reflected back
            # into job state because they may contain internal paths or secrets.
            self._mark_failed(job.id, "internal_worker_error")

        return self.queue.get(job.id) or job

    async def run_next(self) -> IntelligenceJob | None:
        """Atomically claim and execute one queued job, returning None when idle."""
        job = self.queue.claim_next()
        if job is None:
            return None
        return await self.run(job)

    def _mark_failed(self, job_id: str, error: str) -> None:
        try:
            self.queue.update_status(job_id, JobStatus.FAILED, error)
        except QueueError:
            # If persistence itself is unavailable there is no safe secondary
            # channel for job state. Re-raise without exposing provider internals.
            raise QueueError("failed to persist intelligence job failure") from None


def _validate_payload(payload: dict) -> tuple[str, str]:
    if not isinstance(payload, dict):
        raise JobValidationError("job payload must be an object")

    provider = payload.get("provider")
    query = payload.get("query")
    if not isinstance(provider, str) or not provider.strip():
        raise JobValidationError("job payload requires a provider")
    if not isinstance(query, str) or not query.strip():
        raise JobValidationError("job payload requires a query")
    if len(provider) > 64:
        raise JobValidationError("provider name is too long")
    if len(query) > 4096:
        raise JobValidationError("query is too long")
    return provider.strip().lower(), query.strip()
