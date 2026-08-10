# POTAPoff Intelligence Worker

The worker layer orchestrates asynchronous intelligence jobs without depending on any concrete external source, queue backend or document database.

## Job payload

Each job currently requires:

```json
{
  "provider": "github",
  "query": "owner/repository"
}
```

The provider name is resolved through `ProviderRegistry`. The query is passed only to that provider.

## Lifecycle

```text
queued
  -> running
      -> provider.collect(query)
      -> provider.normalize(document)
      -> deduplicate/store
      -> persist result_document_ids
  -> completed

running -> retry -> queued/running
running -> failed
failed  -> retry
```

Terminal jobs cannot transition back to `running`. Repeating the same status is idempotent and does not rewrite execution timestamps.

## Queue contract

`worker/base.py` defines `JobQueue`.

Current implementations:

- `MemoryJobQueue` — unit/local tests;
- `SQLiteJobQueue` — durable queue with atomic `claim_next()` using `BEGIN IMMEDIATE`.

`IntelligenceWorker.run_next()` claims one queued job and processes it. This allows multiple worker processes to compete for jobs without processing the same queued row twice.

## Storage contract

The worker depends only on `DocumentStore`, not on Memory/SQLite/PostgreSQL details. Normalized evidence IDs are persisted back to the queue before the job is completed.

## Failure behavior

- validation/provider/storage/queue domain errors are sanitized before job exposure;
- unknown implementation errors collapse to `internal_worker_error`;
- failed queue persistence raises a generic `QueueError` rather than leaking provider internals.

## Boundaries

The worker must never:

- contain wallet secrets or trading credentials;
- invoke provider-specific APIs directly;
- perform AI scoring inside collectors;
- expose raw unknown exception text to callers;
- allow completed jobs to be silently reclaimed.

`build_memory_runtime()` creates fully in-memory queue/storage. `build_sqlite_runtime(path)` creates durable SQLite queue and normalized document storage in the same database file and exposes a central `runtime.close()` lifecycle hook.
