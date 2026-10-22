# Cross-platform AI analytics

This document describes the additive implementation in the existing Intelligence core.

## Migration order

Apply 001 through 006 in order. Migration 003 (Feature Store) is required for the features API. Migration 007 is optional and requires the pgvector extension; apply it only after 006 on a PostgreSQL server that supports pgvector. Do not modify old checksum-tracked migrations.

## Data correctness

- token_daily_cross_platform stores immutable (token, UTC day, as_of) snapshots.
- max_input_observed_at must not be later than as_of.
- A missing event count is null unless source_coverage_windows contains an explicit complete coverage window for that source/day. No event rows alone never prove zero activity.
- Source coverage windows are immutable. A complete window can only be recorded after the window end.
- Initial scores are heuristics. The backtest must be out-of-sample and use explicit labels in token_outcomes before any score is treated as predictive.
- Current cross-platform refresh derives daily metrics from normalized timeline events. Short-window z-scores remain null until a coverage-aware interval baseline is supplied; momentum is therefore null rather than fabricated.

## API-backed AI

packages/ai-gateway calls configured HTTPS OpenAI-compatible Chat Completions and Embeddings endpoints. AI_GATEWAY_ENABLED must be true. AI_PROVIDERS_JSON names secret environment variables through apiKeyEnv; it must not contain API key values. Model execution through intelligence/src/ai-analysis.ts requires a matching active row in model_registry. No local model is started by this layer.

Migration 007 creates feature_embeddings with 1024-dimensional pgvector values. Register an embedding model with task=embedding, configure the API model to return exactly 1024 dimensions, and mark the registry row active before storing embeddings.

## Backtest CLI

After migrations and outcome labels exist:

npm --prefix intelligence run backtest -- --signal attention_score --outcome price_2x_24h --from 2025-01-01 --to 2025-09-30 --threshold 2.0 --horizon-hours 24

Supported signal columns: attention_score, credibility_score, risk_score, momentum_score. Outcomes must already exist in token_outcomes and be observed after their occurrence time. The command exits with an error when there are no eligible observations; it never synthesizes labels.
