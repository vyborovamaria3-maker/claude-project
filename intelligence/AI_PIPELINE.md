# Collector-backed API AI analysis

Apply migrations 001–006, 008, 009, **010_intelligence_governance.sql**, **011_validation_preregistration.sql**, **012_ai_shared_budget.sql** and **013_invalidation_retry_schedule.sql** to the separate Intelligence destination before enabling the AI runtime. Migration 007/pgvector is optional and is not needed for sentiment, narratives or explanations. Do not apply these migrations to collector databases.

## Execution

With the explicit AI flags below enabled, the existing `etl:once` and foreground `etl:supervise` commands run bounded AI batches **after** normal destination commit and source ACK. They reuse the existing collector pools. API errors do not NACK an already delivered message or restart source collection. No plaintext message text is copied into the Intelligence database. Migration 010 provisions an optional encrypted 30-day-max snapshot contract. AES-256-GCM import/read/purge adapters exist but remain disabled until explicitly enabled, given a secret encryption key and key reference, with a configured purge schedule; no plaintext is stored. The current AI text adapter still performs bounded read-only lookups against source schemas. Do not claim source-schema decoupling until a privacy-reviewed snapshot producer and purge worker are deployed. Successful AI calls have a typed cost-ledger entry; failed/retried/invalid provider calls still require independent billing reconciliation.

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

PostgreSQL tests cover source reads and edits/deletions, legacy schemas, persistence and replay, as-of API/summary results, source worker locks, retry backoff, refresh repair and grounded explanation persistence. Live validation reads a small bounded selection from the actual local `xcollector.twitter_tweets` database and writes only to a disposable destination, then checks the HTTP API and no-call replay. The live Telegram collector database was subsequently available and real messages were read through its existing connection. Small targeted live quality reviews cover ordinary text, warnings, jokes, opposing targets and prior-message context; these are not representative accuracy estimates.

Legacy snapshot reads default to a 120-second statement timeout; normal source lookups default to 5 seconds. Set `INTELLIGENCE_AI_SOURCE_QUERY_TIMEOUT_MS` (1000-300000) for the source connection when needed. This bounds database work without retrying paid AI requests.

Narrative classification abstains below model confidence 0.7 (not a calibrated accuracy estimate). Keywords are nonempty excerpts present in the source (Unicode/case normalized), never added entities or external context. Sentiment describes expressed financial stance, including unverified promotion; it does not verify returns. After upgrading prompts, configure new model IDs/versions for future analyses; immutable old results are not silently relabeled.

Sentiment is message-level, with no selected target asset. The provider must return `directionAmbiguous` (boolean). Opposing views of different assets or unresolved intended direction are stored as `mixed`, score 0, flag true; these results stay visible via API but do not enter token sentiment averages. Missing/invalid flags in new provider responses fail validation. Legacy stored results remain readable. Slang, token names, laughter and hyperbole alone do not prove sarcasm. Deploy with a new sentiment model ID/version; old immutable classifications are not retroactively reinterpreted.

Telegram AI input filtering skips known scanner/card formats (Gamble Found, migration/Alpha One/achievement cards, structured metric/ROI cards, bare addresses and link-only posts) before provider calls. Conversational warnings and jokes are retained; this is a conservative format filter, not a universal spam classifier. Exclusions use existing destination retry bookkeeping with `excluded_template_v1`, attempts=5: they are counted as filtered, never billed or retried for the same event/model. Known exclusions also suppress old AI results from API and AI sentiment lookup as of the exclusion time; original collection/timeline remains intact. Legacy source snapshots inspect at most max(32, batch*16) candidates for up to batch useful messages; this bounded sampler is not a full-history traversal.

For each retained Telegram message, the runtime supplies up to two non-template preceding messages (same source, earlier message IDs and publication times, within 30 minutes, each <=1200 characters). Deleted/unavailable/newer-edited context is excluded. Context must be available at analysis time, rather than at the target's original collection timestamp: historical collectors often collect older messages later. Later published replies are never used. Same source does not prove same author or reply-thread membership. Context reads are shared across sentiment/narrative within the batch. Only context reference IDs, source timestamps and SHA-256 hashes are stored/exposed via `contextEvidence`; raw neighboring text remains in the collector. The target alone is classified. A past feared scenario contradicted by context is marked direction-ambiguous rather than asserted as an actual rug. New prompts require new model IDs/versions; no mass reanalysis or source deletion is performed by this change.

Expanded read-only review sampled 200 collector messages (194 unique texts, 116 sources) and 16 additional contextual target messages. Known repeated VIP result/entry cards and scanner subscription boilerplate are filtered by their full format, not by words such as NOT, VIP or DEX alone. Synthetic analogs of the reviewed language form a retained-input regression fixture without publishing collector texts; a human warning about DEX NOT PAID/VIP is retained. This convenience sample is not a guarantee of zero false positives or general sarcasm accuracy. Filtering excludes AI work, not underlying collector records or entity evidence.

AI attempts retain only an allowlisted stable gateway error code (network/HTTP/auth/rate/budget/capacity/response errors), or `ai_output_validation_failed` for known structured-output validation failures; arbitrary exception text and provider bodies are never stored. Existing bounded backoff and one-attempt gateway behavior remain. The full-runtime PostgreSQL/HTTP regression uses synthetic source messages and an injected network failure to verify filter/context wiring, persistence, API metadata/history, backoff and retry of only the failed task. It makes no paid provider requests.

## Automatic Telegram arrivals without producer outbox

Apply destination migration 015 before using `analyze-ai --source tg --watch` with `INTELLIGENCE_AI_SOURCE_SNAPSHOT_ENABLED=true`. The watcher initializes a durable source cursor at the current high water, then drains subsequent observations in ascending pages (batch 1–8). It does not repeatedly sample the latest historical messages. Page ingestion and cursor advancement commit together; restart resumes the cursor without duplicate completed AI calls. The first run deliberately skips existing history; use explicit backfill for historical imports. Source connections remain read-only.

`INTELLIGENCE_AI_POLL_MS` defaults to 5000 (100–60000); `INTELLIGENCE_AI_MAX_CYCLES` defaults to 0 (continuous), with a bounded positive value useful for verification. Existing AI opt-in, destination/source URLs and active model/provider configuration are still required. This command must be operated as a supervised long-running process; a running Telegram collector alone does not launch it. Producer outbox supervision remains preferred: timestamp polling assumes newly committed observations advance the source watermark and can miss late commits or backdated writes behind it. No claim of guaranteed delivery under those conditions is made.

A controlled arrival replay of two real conversational messages and two real template cards verified an already waiting watcher through context, four live AI task calls, saved results and HTTP API. Two cards incurred zero calls; restart incurred zero calls. This is not evidence of fresh Telegram traffic or permanent production deployment. Regression tests use synthetic messages and cover pagination, microsecond cursor precision, transactional rollback, idle-to-arrival processing, API and restart.
## Intelligence 2.2 operational gates

- Migration 010 adds `ai_cost_ledger`; `createAiRuntime` fails closed without it. A successful typed sentiment/narrative/explanation result logs the provider trace as the idempotency key. Price estimates are NOT reconciled provider invoices; the existing AI Gateway in-memory reservation is process-local, not a cross-worker budget.
- Protected text storage is OPTIONAL and NOT ACTIVE. A separate source-adapter + encryption + purge rollout must precede any event_text_snapshots writes. No raw Telegram/X texts, API keys or session data are logged.
- The central API currently remains loopback-only; no remote POTAPoff gateway is deployed by this migration.

## Opt-in runtime commands added after Intelligence 2.2

The following are **not automatically enabled** by installing migrations:

```bash
npm --prefix intelligence run invalidation:once
npm --prefix intelligence run validation:preregister -- --signal-version <version> --signal <score_column> --threshold <value> --horizon-hours 24 --code-revision <git_sha>
npm --prefix intelligence run validation:holdout -- --run-id <uuid> --signal-version <version> --code-revision <git_sha>
npm --prefix intelligence run gateway:local
npm --prefix intelligence run text-snapshot:import -- --source tg --limit 10
npm --prefix intelligence run text-snapshot:purge
```

Each has a corresponding explicit `*_ENABLED=true` flag. For text snapshots,
use `INTELLIGENCE_TEXT_ENCRYPTION_KEY_B64` and
`INTELLIGENCE_TEXT_KEY_REF` supplied from a secret manager and run purge
regularly. Enabling optional shared budget requires migration 012, a per-provider
configured price, and `INTELLIGENCE_AI_SHARED_DAILY_BUDGET_USD`. Production
rollout must separately validate billing reconciliation, identity mapping,
DB grants and KMS rotation; do not store production keys in this document.

## Token analysis only on explicit request

For request-driven token analysis, use the existing Social AI action with `INTELLIGENCE_AI_ON_DEMAND_ENABLED=true` and `POTAPOFF_TOKEN_INTELLIGENCE_ENABLED=true`. That branch authenticates/rate-limits the user, validates the mint and forwards only its address to the local Intelligence API; client-supplied snapshots are not trusted. Legacy research/Qwen calls are bypassed in this mode.

`POST /api/intelligence/v1/tokens/<encoded solana:mint>/analyze` requires the existing Bearer token and an empty body. GET never starts analysis. No watch, timer, source collector or RPC discovery is launched. Configure the API-only writer through `INTELLIGENCE_AI_DATABASE_URL`, read-only source sessions through `X_SOURCE_DATABASE_URL` and `TG_SOURCE_DATABASE_URL`, and the existing SQLite cache through `SOLANA_TRADE_DB_PATH`. Apply migration 016 after 010 and select an active explanation model using `INTELLIGENCE_AI_TOKEN_MODEL_ID` plus `INTELLIGENCE_AI_MODELS_JSON`. Normal read API connections remain read-only. Provider keys stay server-side via the existing gateway `apiKeyEnv` configuration.

Each request reads bounded literal-address matches from both social stores, filters Telegram scanner cards, supplies up to two earlier context messages, and reads up to 100 existing token_trades rows for that exact mint. Up to four messages per social source and 20 raw trade records reach the model. Literal mentions are not RPC identity verification; legacy stored trades are not independently verified settlement or PnL. Source unavailability fails the request rather than becoming a zero count. Missing/partial coverage stays unknown. This path deliberately does not scan/decode the entire raw blockchain archive or start paid chain collection.

There is at most one provider attempt for an uncached request, with a maximum requested output of 1536 tokens for the per-message classification table. Configure the selected provider's `maxOutputTokens` to at least 1536; shared-budget bounds are not bypassed. Model output must classify every selected message once, identifying its target, intended direction, literal/ironic/negated/conditional/unclear reading and only supplied context references. Reply parents and chronological neighbours are distinguished. The overall result combines these semantic classifications; opposing or unresolved views remain mixed rather than being averaged away. The former phrase-specific warning guard is not used by new analyses.

Invented facts, extra prose, missing/duplicate message views and unknown references fail. Summary fact values are rendered from the input catalog, while tone and irony remain model interpretations. With no relevant token messages, direction is unknown. The report persists source hashes/context relationships, classifications and up to four exact caveats with bounded source excerpts (these excerpts contain source text), model version and measured usage in the existing cost ledger. An input/model/prompt-policy fingerprint and per-token database lock reuse unchanged reports for one hour, including concurrent requests; changed source revisions invalidate the cache. Old cached reports remain readable with their original provenance labels.

Local real-data verification read all three operational stores, identified a missed complete MonstaScan card, and added a narrow full-layout exclusion with human-warning negative controls. A separate Twitter address read returned four messages and filtered three Telegram cards, without another provider request. Local credentials/configuration are not published. Starting the API does not deploy the updated frontend elsewhere; that frontend must run the PR version and server-side flags.

Review hardening (2026-10-25): the Telegram watch cursor includes `deleted_at` and delivers tombstones through the same transactional privacy and invalidation hooks as normal outbox delivery. Deleting a previously watched message revokes its visible analyses and ciphertext, and queues directly linked tokens for recomputation, together with cursor advancement. No source rows are changed.

The request-only runtime also honors `INTELLIGENCE_AI_SHARED_BUDGET_ENABLED` and the shared daily allowance from migration 012. It uses separate budget connections so token-lock holders cannot exhaust their own reservation pool. The process-local gateway reserves UTF-8 bytes plus protocol overhead for every attempt; uncertain or failed remote calls retain that allowance. These conservative allowances can refuse work before the provider's measured invoice limit, and are not billing reconciliation.
## Twitter context

Explicit token requests restore up to two one-hop linked X posts from `twitter_tweet_observations` at the request cutoff. Stored `replyToPostId` and `quotedPostId` retain reply/quote meaning; legacy `relatedPostIds` are labelled `linked_post`, never inferred reply parents. Missing, future, oversized or mismatched observations do not become context. No network lookup or source writes occur. HTTP collector normalization now preserves typed references in observations and archive edges; historical untyped links cannot be retroactively certified. One of the existing four X sample positions may retain a candidate with available linked context, after warning positions. Target text plus context share the existing 16000-character ceiling. The UI projects relation types and the model's used context references; this does not claim complete threads or independently verified author assertions.
