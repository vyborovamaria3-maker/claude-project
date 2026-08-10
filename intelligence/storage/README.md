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

`storage/base.py` defines the `DocumentStore` protocol used by the worker.
The worker must not depend on a concrete database implementation.

Current backends:

- `MemoryDocumentStore` — fast unit/local tests;
- `SQLiteDocumentStore` — durable local/server storage using Python stdlib only.

`postgres_schema.sql` defines the production PostgreSQL table/index contract.
A PostgreSQL runtime adapter should be added only after the repository selects and pins a PostgreSQL driver; the worker API must remain unchanged.

## Required properties

- deterministic hashes;
- deduplication by `raw_hash`;
- evidence traceability;
- UTC-aware timestamps;
- JSON-safe entities/metrics;
- domain-level `StorageError` failures rather than raw database exceptions;
- transaction rollback on failed writes.

SQLite is intended for local/single-process execution. PostgreSQL is the target for multi-worker production persistence.
