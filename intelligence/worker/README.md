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
- `SQLiteJobQueue` — durable single-host queue using WAL plus atomic `BEGIN IMMEDIATE` claims;
- `PostgresJobQueue` — multi-worker production queue using row locks and `FOR UPDATE SKIP LOCKED`.

`IntelligenceWorker.run_next()` claims one queued job and processes it. Both durable backends prevent two workers from successfully claiming the same queued row.

## Storage contract

The worker depends only on `DocumentStore`, not on Memory/SQLite/PostgreSQL details. Normalized evidence IDs are persisted back to the queue before the job is completed.

Runtime factories:

- `build_memory_runtime()` — memory queue + memory documents;
- `build_sqlite_runtime(path)` — SQLite queue + SQLite documents in one WAL database;
- `build_postgres_runtime(dsn)` — PostgreSQL queue + PostgreSQL documents.

PostgreSQL schema creation is explicit: run `python -m intelligence --backend postgres ... init-db` before starting the worker. Migrations are not executed implicitly on normal queries.

## Failure behavior

- validation/provider/storage/queue domain errors are sanitized before job exposure;
- unknown implementation errors collapse to `internal_worker_error` inside a claimed job;
- failed queue persistence raises a generic `QueueError` rather than leaking provider internals;
- the long-running CLI worker retries known runtime persistence failures with bounded exponential backoff;
- unknown programming errors are not swallowed by the long-running loop and cause a non-zero process exit.

## Boundaries

The worker must never:

- contain wallet secrets or trading credentials;
- invoke provider-specific APIs directly outside provider adapters;
- perform AI scoring inside collectors;
- expose raw unknown exception text to callers;
- allow completed jobs to be silently reclaimed;
- print PostgreSQL DSNs in operational output.

`IntelligenceRuntime` exposes a central `close()`/context-manager lifecycle hook. SQLite resources close their persistent connections; PostgreSQL backends use short-lived per-operation connections and therefore expose compatible no-op `close()` methods.
