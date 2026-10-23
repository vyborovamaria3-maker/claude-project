# Cross-platform AI analytics

This document describes the additive implementation in the existing Intelligence core.

## Migration order

Apply 001 through 006, then 008 (historical alert status). Migration 003 (Feature Store) is required for the features API. Migration 007 is optional and requires the pgvector extension; apply it only after 006 on a PostgreSQL server that supports pgvector. Do not modify old checksum-tracked migrations.

## Data correctness

- token_daily_cross_platform stores immutable (token, UTC day, as_of) snapshots.
- max_input_observed_at must not be later than as_of.
- A missing event count is null unless source_coverage_windows contains an explicit complete coverage window for that source/day. No event rows alone never prove zero activity. Coverage windows without a details.scope are treated as timeline_events; set details.scope to token_swap_evidence_revisions or settled_trade_tape for those separate data products.
- Source coverage windows are immutable. A complete window can only be recorded after the window end.
- Initial scores are heuristics. The backtest must be out-of-sample and use explicit labels in token_outcomes before any score is treated as predictive.
- Current cross-platform refresh derives social counts and chain transaction counts from normalized timeline events. It separately resolves current supported swap evidence using latest wallet/signature revisions known at as_of. A supported swap is evidence, not a settled trade or PnL; chain_trades, chain_volume_usd and first_trade_at remain null unless explicit trade_executed events or a scoped settled_trade_tape coverage window exist. Short-window z-scores remain null until a coverage-aware interval baseline is supplied; momentum is therefore null rather than fabricated.

## API-backed AI

packages/ai-gateway calls configured HTTPS OpenAI-compatible Chat Completions and Embeddings endpoints. AI_GATEWAY_ENABLED must be true. AI_PROVIDERS_JSON names secret environment variables through apiKeyEnv; it must not contain API key values. Model execution through intelligence/src/ai-analysis.ts requires a matching active row in model_registry. No local model is started by this layer.

Migration 007 creates feature_embeddings with 1024-dimensional pgvector values. Register an embedding model with task=embedding, configure the API model to return exactly 1024 dimensions, and mark the registry row active before storing embeddings.

## Backtest CLI

After migrations and outcome labels exist:

npm --prefix intelligence run backtest -- --signal attention_score --outcome price_2x_24h --from 2025-01-01 --to 2025-09-30 --threshold 2.0 --horizon-hours 24

Supported signal columns: attention_score, credibility_score, risk_score, momentum_score. The CLI uses the latest eligible point-in-time snapshot per token and UTC signal day so repeated refreshes do not overweight a token-day. Dates are validated as real UTC calendar days. Outcomes must already exist in token_outcomes and be observed after their occurrence time. Each signal also requires its relevant metric fields and complete source-coverage windows known by that snapshot's as_of time (swap-revision coverage for attention; settled-trade-tape coverage for momentum). The command fails closed when any eligible token-day has an unfinished outcome horizon or lacks an explicit label; it never assumes missing outcomes are false. It prints aggregate eligibility, maturity and label-coverage counts without leaking row payloads. Results are exploratory unless validated out of sample. When the same token appears repeatedly, naive independent-sample confidence intervals and p-values are omitted. The random baseline samples the full eligible cohort and is not used for independent two-sample significance tests.


## Refreshing the daily cross-platform view

Backtest `--from`/`--to` bound UTC signal dates, not the source aggregation `day`. A signal becomes available at `GREATEST(as_of,created_at)`; refresh records `created_at` with the database wall clock at insertion, rather than the transaction start. Outcomes and completed horizons are measured from that availability time. The range is applied before selecting the latest available snapshot per token/UTC signal day, including snapshots for earlier source days. Recomputed historical snapshots therefore cannot be used as signals before their actual write time.

Correlation input accepts one observation per token/event kind/outcome kind/event time. Exact replays and conflicting labels for that observation are rejected before persistence. Distinct overlapping windows can still be dependent; correlation results remain exploratory and require independent out-of-sample validation.

After migrations and source event ingestion, refresh tokens that had observed timeline events on a UTC day:

```sh
npm --prefix intelligence run refresh-cross-platform -- --day 2026-10-22 --as-of 2026-10-23T00:15:00Z
```

To include registered tokens with no observed event, explicitly request a bounded all-token run:

```sh
npm --prefix intelligence run refresh-cross-platform -- --day 2026-10-22 --as-of 2026-10-23T00:15:00Z --all-registered --limit 1000
```

A token with no day events can produce zero counts only if the corresponding source has a complete coverage window known by the supplied as-of time. Otherwise the source metrics remain null. The command does not mark source windows complete; the source collector must record verified coverage through recordSourceCoverageWindow after its scan finishes. For example, pass details: { scope: "timeline_events" } for event history, { scope: "token_swap_evidence_revisions" } for a fully scanned swap-revision window, or { scope: "settled_trade_tape" } only when settled trade events are independently complete.


## Telegram alert delivery

Configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the runtime secret store, then run:

```sh
npm --prefix intelligence run dispatch-telegram-alerts
```

The dispatcher claims alerts with row locks, marks them as sending, posts plain text without parse mode, then marks successful deliveries. Failed attempts return to open; after 10 attempts they are left for manual review. A stale sending claim can be retried after 10 minutes. Delivery is at-least-once, not exactly-once: if Telegram accepts a message but the database status update fails, a retry can duplicate it. A stable alert ID is included in messages to identify duplicates. New alerts for an active token/type incident are suppressed until the prior incident is explicitly resolved. Run the dispatcher from a scheduler if recurring delivery is required. The bot token is never logged or written to PostgreSQL.
