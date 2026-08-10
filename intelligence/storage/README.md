# Intelligence Storage

Storage layers:

1. RAW
- original provider payloads

2. NORMALIZED
- `IntelligenceDocument` objects

3. DERIVED
- scores
- sentiment
- risk analysis
- alerts

## Normalized store contract

`storage/base.py` defines the `DocumentStore` protocol used by the worker. The worker does not depend on a concrete database implementation.

Current backends:

- `MemoryDocumentStore` — fast unit/local tests;
- `SQLiteDocumentStore` — durable single-host storage using WAL, busy timeout and stdlib SQLite;
- `PostgresDocumentStore` — production PostgreSQL storage using pinned psycopg 3, native JSONB and `raw_hash` deduplication.

`postgres_schema.sql` is the source-of-truth PostgreSQL DDL for both normalized documents and durable jobs. `postgres_schema.py` applies that repository-owned DDL idempotently through the explicit `init-db` operation; normal reads/writes never run migrations implicitly.

## Runtime selection

SQLite:

```bash
python -m intelligence --backend sqlite --db /var/lib/potapoff-intelligence/intelligence.sqlite3 init-db
python -m intelligence --backend sqlite --db /var/lib/potapoff-intelligence/intelligence.sqlite3 worker
```

PostgreSQL:

```bash
export POTAPOFF_INTELLIGENCE_BACKEND=postgres
export POTAPOFF_INTELLIGENCE_POSTGRES_DSN='postgresql://...'
python -m intelligence init-db
python -m intelligence worker
```

The DSN is never included in normal CLI JSON output or domain error strings. Production deployments should inject it through a secret manager rather than committing it to Compose or source control.

## Required properties

- deterministic hashes;
- deduplication by `raw_hash`;
- evidence traceability;
- UTC-aware timestamps;
- JSON-safe entities/metrics;
- domain-level `StorageError` failures rather than raw database exceptions;
- transactional failed-write behavior;
- bounded `list_recent(limit)` queries for operational views.

SQLite is appropriate for a single host and uses WAL so a read-only Control Center connection can coexist with the writer. PostgreSQL is the multi-worker production backend.
