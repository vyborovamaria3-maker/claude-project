from __future__ import annotations

from intelligence.errors.exceptions import IntelligenceError, JobValidationError
from intelligence.providers.registry import ProviderRegistry
from intelligence.security.sanitizer import sanitize_text
from intelligence.storage.base import DocumentStore
from intelligence.worker.queue import IntelligenceJob, JobStatus, MemoryJobQueue


class IntelligenceWorker:
    def __init__(
        self,
        queue: MemoryJobQueue,
        registry: ProviderRegistry,
        store: DocumentStore,
    ) -> None:
        self.queue = queue
        self.registry = registry
        self.store = store

    async def run(self, job: IntelligenceJob) -> IntelligenceJob:
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

            job.result_document_ids = stored_ids
            self.queue.update_status(job.id, JobStatus.COMPLETED)
        except (IntelligenceError, ValueError, TypeError) as exc:
            self.queue.update_status(
                job.id,
                JobStatus.FAILED,
                sanitize_text(str(exc))[:500],
            )
        except Exception:
            # Unknown implementation errors are intentionally not reflected back
            # into job state because they may contain internal paths or secrets.
            self.queue.update_status(job.id, JobStatus.FAILED, "internal_worker_error")

        return job


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
