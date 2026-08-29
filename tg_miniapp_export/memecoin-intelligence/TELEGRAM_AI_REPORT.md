# Telegram Qwen AI implementation report

## Version

`Memecoin Intelligence v3.3.0 — Telegram Qwen AI Foundation`

## Implemented

- optional local `Qwen/Qwen2.5-7B-Instruct` service;
- OpenAI-compatible `/v1/chat/completions` interface;
- Transformers + bitsandbytes NF4 4-bit loading;
- lazy model download into a persistent Docker volume;
- mock mode that needs no GPU, API or model weights;
- Telegram-only synchronous and queued analysis APIs;
- BullMQ Telegram AI queue with concurrency one by default;
- PostgreSQL persistence for channels, partitioned messages, features, runs, evidence links and results;
- strict JSON output schema validated with Zod;
- automatic one-time JSON repair request after invalid model output;
- evidence-reference validation against the supplied Telegram message IDs;
- rejection of `<think>` output in stored results;
- short `reasoningSummary` instead of private chain-of-thought;
- Redis caching and in-flight request deduplication;
- request limits and rate limits for expensive inference routes;
- optional bearer token between the Node application and Python inference service;
- model weights excluded from the repository.

## Telegram-only boundary

The X provider, X feature extraction, X network analysis and token analysis services have no imports from the Telegram AI module. A regression test enforces this boundary.

## REST API

- `GET /api/telegram-ai/status`
- `POST /api/telegram-ai/analyze`
- `POST /api/telegram-ai/enqueue`
- `POST /api/telegram-ai/job`

## Database migration

`db/migrations/004_telegram_qwen_ai.sql`

Main tables:

- `telegram_channels`
- `telegram_messages`
- `telegram_message_features`
- `telegram_ai_runs`
- `telegram_ai_run_messages`
- `telegram_ai_results`
- `telegram_ai_cache`

## Verification completed

- TypeScript syntax transpilation: 60 files passed;
- Python service compilation: passed;
- deterministic Telegram campaign test: passed;
- copied-text and shared-link signals: detected;
- relationship evidence IDs: valid;
- Telegram/X module-boundary test: passed;
- JSON and Docker Compose YAML parsing: passed;
- model-weight leakage scan: passed.

## Not executed in this environment

The real 7B model was not downloaded or loaded because this environment has no accessible npm/Python model registry and no CUDA GPU. Full `npm install` also could not complete because registry DNS resolution returned `EAI_AGAIN`. The project therefore includes a tested mock path and a compiled inference service, but real-device throughput and VRAM usage must be measured on the target machine.

## Conservative 8 GB defaults

- Qwen input cap: 8,192 tokens;
- application input cap: 60 messages / 24,000 characters;
- output cap: 1,200 tokens;
- model concurrency: one request per worker.

These values reduce runtime and KV-cache pressure. They are configurable and do not change the model's upstream maximum context capability.
