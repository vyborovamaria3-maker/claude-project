# v3.0.0 migration report

## Removed

- `the previous platform` and `@the previous platform/react-query`
- the previous platform server bootstrap, Store database and session runtime
- the previous platform login/signup/logout pages and UI references
- the previous platform build/start scripts and `.the previous platform` output

## Added

- Fastify API with rate limiting, CORS, Helmet and structured errors
- REST replacement for every previous `xanalysis.*` query/mutation
- PostgreSQL schema for tokens, accounts, posts, mentions, graph edges, analysis runs, clusters and snapshots
- monthly partition creation, BRIN/GiN/B-tree indexes and import audit batches
- Redis/BullMQ dependencies and Docker services for future workers
- provider interface separating analytics from data acquisition
- free fixture provider and reproducible sample campaign
- portable SQL migration runner and seed script
- database integration contract for another project

## Scale boundary

This version is prepared for high-volume ingestion, but a real firehose still requires a licensed data source and worker deployment. The analytics engine can be tested fully without that source.

# v3.3.0 Telegram Qwen AI migration

## Added

- `db/migrations/004_telegram_qwen_ai.sql`
- partitioned `telegram_messages` storage
- deterministic `telegram_message_features`
- `telegram_ai_runs`, `telegram_ai_run_messages`, `telegram_ai_results` and `telegram_ai_cache`
- isolated local inference service under `ai/qwen-service`
- Telegram-only queue, worker and REST API

## Portability

The migration is additive and has no dependency on the frontend. It can be copied into another PostgreSQL project after the base `pgcrypto` extension is available.

## Deliberate boundary

No X/Twitter route, provider or analysis service imports the Telegram AI module. Enabling Qwen cannot change X analysis results.
