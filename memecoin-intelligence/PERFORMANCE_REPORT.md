# Performance overhaul report — v3.2.0

Implemented:

1. O(n²) account comparison replaced by indexed candidate blocking.
2. In-memory fixture index with mtime invalidation.
3. Redis response cache and duplicate-request collapsing.
4. Batch PostgreSQL account, post and feature upserts.
5. Persistent post feature schema with GIN and fingerprint indexes.
6. Separate BullMQ queues and independently scalable worker process.
7. Streaming NDJSON stress generator and benchmark suite.
8. Runtime metrics for candidate pruning, network duration and memory.
9. Configurable DB pool, batch size, worker concurrency and graph limits.
10. Additive migration suitable for merging into another PostgreSQL project.
