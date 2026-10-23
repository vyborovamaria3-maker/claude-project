# Collector-backed API AI analysis

Apply migrations 001â€“006, 008 and **009_ai_analysis.sql** to the separate Intelligence destination. Migration 007/pgvector is optional and is not needed for sentiment, narratives or explanations. Do not apply these migrations to collector databases.

## Execution

With the explicit AI flags below enabled, the existing `etl:once` and foreground `etl:supervise` commands run bounded AI batches **after** normal destination commit and source ACK. They reuse the existing collector pools. API errors do not NACK an already delivered message or restart source collection. No message text is copied into the Intelligence database.

For existing collector databases without the new outbox schema, the read-only snapshot worker is available:

```sh
npm --prefix intelligence run analyze-ai -- --source x
npm --prefix intelligence run analyze-ai -- --source tg --watch
```

`--watch` is a foreground loop, stops on SIGINT/SIGTERM, and retains one gateway instance so its request/cost limits are not reset each poll. A finite run returns nonzero when AI or refresh fails. It does not install a scheduled task or start collectors.

Set source and destination connection strings through the existing local secret environment: `X_SOURCE_DATABASE_URL`, `TG_SOURCE_DATABASE_URL`, `INTELLIGENCE_DATABASE_URL`. For the legacy worker set `INTELLIGENCE_AI_SOURCE_SNAPSHOT_ENABLED=true`. The snapshot reader handles X millisecond timestamps and TG timestamps, ignores deleted TG messages, and refuses to read newer edited text under an older delivered event. Legacy X numeric author IDs are read from `archive_posts` when available. If no stable author identity exists, the record is explicitly unattributed; handles and task-context mints are never promoted to author/token identities.

## Model configuration

```env
INTELLIGENCE_AI_ENABLED=true
INTELLIGENCE_AI_BATCH_SIZE=2
AI_GATEWAY_ENABLED=true
AI_DEFAULT_PROVIDER=primary
AI_PROVIDERS_JSON=[{"id":"primary","baseUrl":"https://tooken.club/v1","apiKeyEnv":"PRIMARY_AI_API_KEY","chatModel":"gpt-5.6-luna","maxConcurrent":1,"requestsPerMinute":20,"maxOutputTokens":700}]
INTELLIGENCE_AI_MODELS_JSON=[{"modelId":"sentiment-live-v1","provider":"primary","name":"gpt-5.6-luna","version":"2026-10-23","task":"sentiment"},{"modelId":"narrative-live-v1","provider":"primary","name":"gpt-5.6-luna","version":"2026-10-23","task":"narrative"},{"modelId":"explanation-live-v1","provider":"primary","name":"gpt-5.6-luna","version":"2026-10-23","task":"explanation"}]
```

Supply `PRIMARY_AI_API_KEY` separately through the runtime secret environment; never put a key value in provider JSON or commit it. Explicit AI initialization registers the configured model identities as active; an existing shadow/deprecated model must be reviewed and activated separately. Duplicate tasks, model identity collisions and incomplete destination schema fail closed. Change model IDs/versions when changing model identity. Configured provider prices and process cost ceilings can be added through the existing Gateway fields. There is one provider attempt per task; failed message/alert analyses have a five-minute backoff and stop after five failures. Batch size is per task, so two tasks with batch size2 allow up to four message calls, plus at most two explanation calls.

The example model accepted the service format in a live check on 2026-10-23. `gemini-3.8-flash` at this provider accepted a minimal request but rejected the current service parameter combination; do not assume every advertised model supports the same format. No automatic paid model fallback occurs. Embeddings require a separately supported 1024-dimensional model and optional migration007; they are not silently simulated when unsupported.

## Storage, facts and historical queries

Successful results are immutable, keyed by source revision/text hash/task/model, with model version, trace ID and actual analysis time. Concurrent message workers serialize per source. Replayed completed source events make no new AI calls. Durable retry rows record only safe error codes. A separately persisted refresh request repairs failed daily-summary updates without paying for reanalysis.

Daily refresh uses AI sentiment only after its actual analysis time. Source observation, destination ingestion and token-link knowledge times all remain bounded by `asOf`. A later message revision is one message, not another mention; an old sentiment result does not apply to its newer text. Known token-link invalidations suppress stale AI attribution, including after re-verification for another token. AI does not assign token identities.

Explanation models return **fact IDs**, not prose or numeric claims. Only recognized typed facts from the stored alert enter the catalog. The application renders those facts deterministically; unknown IDs, extra prose, forecasts and substituted values fail. Facts are verified again before persistence, and saved explanations carry `grounding.version=alert-facts-v1`. Old free-text explanations are not exposed by the new API. Sentiment/narrative remain model classifications rather than verified market outcomes.

## API

Existing Bearer authentication, loopback binding, bounded limits and no-store response policy apply:

- `GET /api/intelligence/v1/ai?asOf=<UTC>&source=x&limit=50`: collected-message results, including explicitly unattributed records. `source` can be `x`/`tg` or omitted.
- `GET /api/intelligence/v1/tokens/<canonical-id>/ai?asOf=<UTC>&limit=50`: results for direct or verified token links, with historical invalidation protection.
- `GET /api/intelligence/v1/signals?asOf=<UTC>`: includes only saved, grounded explanations available by that time.
- Token summary refresh includes known AI sentiment; raw source text, source credentials and provider responses are not exposed.

## Validation

PostgreSQL tests cover source reads and edits/deletions, legacy schemas, persistence and replay, as-of API/summary results, source worker locks, retry backoff, refresh repair and grounded explanation persistence. Live validation reads a small bounded selection from the actual local `xcollector.twitter_tweets` database and writes only to a disposable destination, then checks the HTTP API and no-call replay. The local TG audit database is empty and the configured live TG endpoint was unavailable; synthetic PostgreSQL TG integration is not claimed as live Telegram validation.

Legacy snapshot reads default to a 120-second statement timeout; normal source lookups default to 5 seconds. Set `INTELLIGENCE_AI_SOURCE_QUERY_TIMEOUT_MS` (1000–300000) for the source connection when needed. This bounds database work without retrying paid AI requests.

Narrative classification abstains below model confidence 0.7 (not a calibrated accuracy estimate). Keywords are nonempty excerpts present in the source (Unicode/case normalized), never added entities or external context. Sentiment describes expressed financial stance, including unverified promotion; it does not verify returns. After upgrading prompts, configure new model IDs/versions for future analyses; immutable old results are not silently relabeled.

Sentiment is message-level, with no selected target asset. The provider must return `directionAmbiguous` (boolean). Opposing views of different assets or unresolved intended direction are stored as `mixed`, score 0, flag true; these results stay visible via API but do not enter token sentiment averages. Missing/invalid flags in new provider responses fail validation. Legacy stored results remain readable. Slang, token names, laughter and hyperbole alone do not prove sarcasm. Deploy with a new sentiment model ID/version; old immutable classifications are not retroactively reinterpreted.
