# Historical architecture baseline — 2026-10-12

This file preserves the original collector-focused baseline that previously occupied `CURRENT_ARCHITECTURE.md`. It is historical evidence, not a description of the whole current monorepo.

Repository inventory at that time: x-collector (Node/TypeScript), solana-launcher (Next.js plus Python backend/frontend), intelligence (Python ingestion/scoring), admin-site, memecoin-intelligence, cockpit-tools, subscription service, Telegram miniapp and supporting scripts. This audit followed collector execution paths; other products were inventoried, not exhaustively reviewed.

Collector: `scripts/scheduler.ts` schedules analytics and enqueueTasks under PostgreSQL advisory locks. `lib/trade/tasks.ts` owns durable `x_tasks`, retry and `x_tasks_dlq`; claim uses `FOR UPDATE SKIP LOCKED`. `scripts/worker.ts` claims one task, validates schemas, reserves `x_accounts`, decrypts sessions, calls `searchTweets/fetchUserTimeline/fetchAccountProfile` and saves through `collector-store.ts`. These are Playwright operations, including list/history modes and incremental batches. An opt-in X_COLLECTOR=src search path uses `src/x/task-handler.ts/searchX`.

Storage: `lib/trade/pg.ts` is the shared pool; `migrations.ts` lists required SQL migrations (including repeated numeric prefixes). Tweets, observations, task links, profiles, archives and raw intelligence events are persisted. `src/intelligence/entities/processor.ts` extracts deterministic entities; `scripts/intelligence-worker.ts` normalizes raw events with savepoints and bounded failures. Reply publication has a separate existing runtime and official API adapter.

Operations: WorkerRegistry persists heartbeat/counters in `x_workers`. Dashboard exposes existing analytics and collector control with Basic Auth/origin guards. Launcher `lib/xcollector.ts` starts processes using spawn and tracks handles in memory; it is a local controller, not a durable distributed supervisor. Dockerfile/compose.reply.yml target the reply module. No Redis/BullMQ dependency in collector package.

Historical verification: npm ci succeeded; strict TypeScript passed. Existing tests included PGlite SQL, browser fixtures and optional real PostgreSQL integration. Live X credentials were not provided.

For the current whole-repository baseline, use [CURRENT_ARCHITECTURE.md](CURRENT_ARCHITECTURE.md) and [REPOSITORY_BASELINE_20261030.md](REPOSITORY_BASELINE_20261030.md).
