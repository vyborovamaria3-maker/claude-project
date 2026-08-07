# Changelog

## 3.3.0 — Telegram Qwen AI Foundation

### Added

- isolated Telegram-only AI module
- local OpenAI-compatible Qwen2.5-7B-Instruct inference service
- optional Transformers NF4 4-bit loading
- strict Zod JSON output contract with evidence message IDs
- deterministic mock analyzer for free tests
- Telegram AI BullMQ queue and dedicated worker
- partitioned Telegram channel/message schema
- persisted Telegram AI runs, message links, results and cache metadata
- model health/status and synchronous/queued REST endpoints
- fixture campaign and Telegram AI regression test

### Safety and reliability

- AI output is stored as hypotheses, not proof of common ownership or paid promotion
- private chain-of-thought is never requested or stored
- malformed model JSON is rejected by schema validation
- model weights and secrets are excluded from the repository
- Telegram AI is disabled by default and is not imported by the X pipeline

## 3.2.0 — Ultra Performance Engine

### Added

- indexed network candidate generation
- persistent post feature tables and GIN indexes
- batch PostgreSQL ingestion
- Redis result cache and in-flight request deduplication
- independent BullMQ worker process and queue separation
- asynchronous analysis API
- streaming NDJSON stress-data generator
- benchmark runner and comparison utility
- graph pruning and latency metrics in the API and UI
- configurable performance limits

### Changed

- fixture provider now caches and indexes the fixture file
- network analysis no longer performs unconditional all-pairs comparison
- frontend query caching defaults were tuned
- unused Base UI runtime and components were removed
- version updated to 3.2.0

### Fixed

- NodeNext import extension in `analytics.ts`
- repeated fixture parsing
- unbounded duplicate analysis requests
- expensive single-row persistence path
