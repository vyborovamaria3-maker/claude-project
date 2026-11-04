# FOMO Pressure and FOMO Quality

## Purpose

The existing `FOMO score` is preserved unchanged and exposed as `FOMO Pressure`.
Pressure measures heuristic attention intensity; it is not a probability of price
appreciation or a trading signal.

`FOMO Quality` is an additional deterministic heuristic intended to describe how
credible and diversified the observed attention looks. It is not a probability,
a guarantee that manipulation is absent, or a substitute for market-risk checks.

## FOMO Pressure (legacy formula)

The existing formula remains:

- Hype: weight 0.55
- Positive sentiment: weight 0.25 (the existing maximum of available X/TG positive shares)
- Telegram call density: weight 0.20 when Telegram is available

The shared `weightedScore` helper renormalizes over available components. The legacy
`FOMO score` table row remains available for compatibility and should equal
`FOMO Pressure`.

## FOMO Quality (new heuristic)

The score is a coverage-aware weighted combination of existing metrics:

- Organic score: 0.45
- Inverse manipulation score (100 - manipulation): 0.25
- Cross-platform temporal alignment: 0.15 when both platforms have timestamped events
- X author diversity: 0.075 when X has mentions
- Telegram source diffusion: 0.075 when Telegram has mentions

Missing components are omitted and remaining weights are renormalized. A 0.25
coverage penalty is applied by `weightedScore`, and the separate coverage value is
the share of configured component weight that had usable input. That value is not
the proportion of all posts or accounts observed.

## Caveats

- These are heuristics, not probabilities or investment advice.
- Organicity, manipulation, copy ratio, and author/source diversity share some
  underlying inputs; Quality is intentionally a composite indicator, not a
  statistically independent signal.
- Missing or sampled data can change both the score and its coverage.
- Backtesting against timestamp-correct historical data is required before using
  either score as a predictive feature.
- The legacy Pressure formula is not recalibrated in this change.


## FOMO Pressure / Quality historical evaluation

The FOMO-specific evaluator is separate from the cross-platform `attention_score` backtest:
`scripts/fomo-backtest.mjs` compares recorded point-in-time `fomoPressure` and `fomoQuality` values
against fixed-horizon price outcomes. It never recalculates past FOMO values from today's social data.

### Snapshot capture

The Social Intelligence UI now triggers `POST /api/trade/fomo-snapshot` after both X and Telegram responses are available.
The route fetches the canonical source responses server-side, computes scores server-side at a fixed `signalAt`,
and stores snapshots in the local `data/trade.db` SQLite database. The browser submits only the mint, not scores.
Capture attempts (including failures) are recorded separately. A unique 15-minute token/version bucket prevents duplicate
captures and preserves the first snapshot in that bucket.

The capture uses a fixed query configuration (24-hour lookback, bounded X sample of up to 40 posts, Telegram timeline
limit 200) so scores remain comparable across UI filter changes. Bump `FOMO_SCORE_VERSION` in
`lib/trade/fomo-snapshot.ts` when the formula or capture query configuration changes.

For each snapshot the database stores the FOMO Pressure and Quality scores, Quality component coverage, score version,
signal time, maximum input-observed time, per-source sample counts, truncation/cache flags, source response timestamps,
source-response SHA-256 hashes, a combined input hash, a snapshot hash, and bounded metadata. Raw tweet/message bodies
are not persisted by this capture feature. Future-dated social events are rejected.

**X and Telegram coverage is always labelled partial** because the current APIs return bounded/filtered samples rather than
proof of exhaustive platform history. "Not truncated" does not mean "complete coverage." Unknown source coverage is rejected
by the evaluator; explicitly partial coverage can be evaluated but must be reported as sample-conditional, not population-wide.

### Exporting captured snapshots

From `solana-launcher`, export the signal history:

~~~sh
npm run fomo:snapshots:export -- --from 2026-10-27 --to 2026-12-31 --output ./data/fomo-snapshots.jsonl
~~~

The export includes the snapshot/source hashes, score version, as-of timestamps, coverage flags, and source metadata, but leaves
price outcomes null. **It is not directly backtest-ready** until a separate price-outcome joiner supplies a fixed-horizon return,
drawdown, evidence reference, and verified outcome coverage. The current token-trade cache does not by itself prove continuous
price coverage, so missing candles must not be treated as zero returns or as a complete outcome.

### Joining price outcomes

Start the local Next.js app with real provider credentials/configuration (the joiner rejects mock candles), then run:

~~~sh
npm run fomo:price-join -- \
  --input ./data/fomo-snapshots.jsonl \
  --output ./data/fomo-labelled.jsonl \
  --evidence-output ./data/fomo-price-evidence.jsonl \
  --audit-output ./data/fomo-price-join-audit.json \
  --horizon-hours 24
~~~

The joiner calls the local `/api/token-history` route using deep 5-minute candles by default. Use
`--base-url http://127.0.0.1:3000` if the app is served elsewhere, or `--timeframe 1m` for finer candles.
This CLI requests Bitquery candles explicitly tagged `priceUnit: USD`. The local autonomous worker described below uses a separate verified GeckoTerminal adapter. The local app must have `BITQUERY_API_KEY` configured. The joiner requests Bitquery explicitly so the route cannot silently fall back to Pump.fun or GeckoTerminal. The current bounded query supports horizons up to 72 hours with `1m` candles or 360 hours with `5m` candles; longer horizons need a wider historical data source. Pump.fun is rejected until its candle units are explicitly normalized to USD; Generic GeckoTerminal fallback data is rejected because it does not prove the requested token orientation. Only the dedicated adapter with hashed pool/token/USD provenance is accepted. Mock and unsupported sources are rejected. It uses the first complete candle open at or after the signal (maximum
5-minute entry delay), then the nearest complete candle close to `signalAt + horizon` (maximum 5-minute offset).
Every candle between entry and exit must be present at the chosen interval. Gaps are excluded; prices are never interpolated,
and missing candles are never treated as zero returns.

The labelled output contains **only rows with a matured horizon and complete contiguous price bars**. All excluded snapshots
and reason codes are recorded in the audit JSON. The evidence JSONL stores the returned price candles, source, retrieval time,
timeframe, and a SHA-256 evidence hash; keep this file with the labelled output. `outcomeObservedAt` and
`outcomeCoverage.knownAt` record when this join run observed and validated the prices, not when the historical
trades originally happened. The audit report's `cutoffAt` is the dataset cutoff to pass to the backtest.

Example backtest using the cutoff recorded in the audit report:

~~~sh
npm run fomo:backtest -- \
  --input ./data/fomo-labelled.jsonl \
  --from 2026-10-27 --to 2026-12-31 \
  --cutoff-at "$(node -p 'JSON.parse(require("fs").readFileSync("./data/fomo-price-join-audit.json","utf8")).cutoffAt')" \
  --horizon-hours 24
~~~

Adjust the example date range to the snapshots you intend to evaluate; the cutoff is read directly from the join audit report. The joiner's OHLC drawdown estimate is
conservative: within each candle it assumes the high happened before the low. This is not tick-level path reconstruction, and
a contiguous provider response is evidence of continuity only for the labelled interval, not proof of completeness outside it. Returns are gross price changes and do not model fees, slippage, liquidity constraints, or whether a token can actually be sold.

### Backtest contract

The JSONL evaluator requires `canonicalTokenId`, `signalAt`, `maxInputObservedAt`,
`scoreVersion`, both scores, and source-coverage status/known-at time, plus a matured fixed-horizon price outcome.
`maxInputObservedAt` must be no later than `signalAt`. Outcome timestamp must be within five minutes of the
configured horizon; the outcome must have been observed and its price coverage known by the configured cutoff. Unknown source
coverage and incomplete outcome labels fail closed.

Reports include mean/median forward returns, positive-return and target-hit rates, adverse-drawdown rates, cohort comparisons,
and Spearman rank correlations. Repeated observations for the same token can be dependent; no naive p-values or independent-sample
confidence intervals are reported. Partial source coverage can bias the captured sample and must remain visible in interpretation.

**Data limitation:** snapshots begin accumulating only when this branch/version is running and tokens are analyzed in the UI or the local autonomous worker is enabled. This
does not reconstruct historical FOMO scores. Do not pair current scores with past prices, and do not claim predictive performance
until enough point-in-time snapshots have matured and have matching price outcomes with defensible coverage.


## Resumable price-outcome queue

`npm run fomo:outcomes -- --db ./data/trade.db --base-url http://127.0.0.1:3100 --horizon-hours 24 --timeframe 5m --limit 25`

This bounded one-shot worker reads the existing immutable snapshots directly. It does not capture new social data or reconstruct historical scores. Run it periodically with your existing scheduler, or repeat manually. A read-only inventory is available with `npm run fomo:outcomes -- --db ./data/trade.db --horizon-hours 24 --status`.

The worker waits for a matured horizon before requesting prices, groups requests by mint, and stores successful labels and hashed candle evidence transactionally in the same SQLite database. A second run skips completed labels. Other horizons can reuse already stored evidence if those candles prove complete coverage for the requested interval. All original source/unit/gap/look-ahead checks from the joiner remain in effect.

Tables `fomo_price_outcomes`, `fomo_price_evidence`, and `fomo_price_attempts` preserve the result, its source proof, and exclusion/retry reasons. Missing prices are not zero returns. Temporary source failures and incomplete price coverage retry after15 minutes. Unknown immutable signal coverage and snapshots outside the bounded provider window are explicit exclusions. The source-window exclusion can be avoided only if suitable verified evidence was already saved; a wider historical provider is needed otherwise. A single fenced90-second lease prevents parallel workers and stale owners from publishing duplicate results. Checkpoints and labels survive process restarts.

Export accepted labels and their evidence together:

~~~sh
npm run fomo:outcomes -- --db ./data/trade.db --base-url http://127.0.0.1:3100 --horizon-hours 24 --output ./data/fomo-labelled.jsonl --evidence-output ./data/fomo-price-evidence.jsonl
~~~

The console report includes `cutoffAt`, per-run request/cache counts, accumulated label/attempt counts and immature snapshots. Use that cutoff with the existing `fomo:backtest` command. Keep the evidence export next to the labels; export verifies its SHA-256 and rejects changed snapshot identities. Each horizon/timeframe has independent labels. Already accepted outcomes are not overwritten by later API responses. Export paths must not collide with the source database.

Validation uses generated test candles only: no live historical performance is claimed. Real labels require matured point-in-time snapshots and verified contiguous USD evidence from the configured provider. The one-shot CLI defaults to Bitquery; the autonomous worker uses verified GeckoTerminal. These are gross OHLC returns, not executable trading PNL.


## Autonomous local capture and outcomes (Node 24)

`npm run fomo:local -- --config /absolute/path/fomo-local.json`

Configuration contains paths only; secrets remain in existing local environment files:

```json
{
  "db": "/absolute/path/solana-launcher/data/trade.db",
  "sourceEnv": "/absolute/path/solana-launcher/.env.local",
  "xEnv": "/absolute/path/x-collector/.env",
  "statusFile": "/absolute/path/fomo-evaluation.json",
  "watchLimit": 12,
  "outcomeLimit": 12
}
```

The database must already exist. X `DATABASE_URL` is read from `xEnv`; Telegram `TG_COLLECTOR_DATABASE_URL` from `sourceEnv`. Both PostgreSQL sources are queried in read-only transactions. This worker does not call an LLM or change the existing collectors. It can run independently of Next.js/FastAPI. Use the existing process supervisor to restart it after exit and on sign-in.

Every15 minutes the worker selects known Solana mints from stored Fomo thoughts, prioritizing exact mint mentions in the latest24-hour Telegram sample. It reads up to40 X and200 TG posts per token, rejects future observations, skips empty evidence and records source failures separately. The watchlist and source coverage are bounded samples, not all Fomo traders, all X or all Telegram. Freshness/counts and known-token overlaps are visible in the status JSON. A stopped X source is not repaired by this evaluation worker.

The score series is explicitly `fomo-pressure-quality-local-pg-v1`, separate from browser/search series `fomo-pressure-quality-v1`. Matching is exact mint only. No bot classifier is available in this corpus: the legacy Pressure inputs use a disclosed neutral risk prior50, while the organic/manipulation Quality components are omitted. Quality component coverage is at most30%; no clean-bot classification is inferred. Local raw source bodies remain in their existing source databases; score records retain hashes/metadata only.

Every5 minutes it processes matured1/6/24-hour horizons using5-minute OHLCV. A bounded initial probe saves real candle evidence for the first two newly captured tokens, without assigning an immature return. GeckoTerminal pool relationships and response metadata must agree with the requested mint; the request explicitly selects the correct base/quote side and `currency=usd`, `include_empty_intervals=false`. These requirements follow the [official OHLCV contract](https://coingecko-api-v3.readme.io/v3.0.1/reference/pool-ohlcv-contract-address). Requests are paced at least7 seconds apart and use the [public API](https://api.geckoterminal.com/docs/index.html); rate limits still cause retries. No Bitquery key is needed for this worker.

A response has at most1000 candles (~83 hours at5m); uncached signals older than80 hours are excluded rather than endlessly retried. Thinly traded tokens can have missing candles and therefore no valid outcome. Provider absence is not a zero return. Schedules, immutable snapshots, attempts and labels live in SQLite. A renewable fenced process lease prevents stale capture writes, alongside the outcome worker's separate fenced lease. Interruptions recover from saved schedules; first-write bucket uniqueness prevents duplicate snapshots.

`statusFile` includes source freshness, recent score/sample counts, price evidence counts, per-horizon maturity/labels and recent failure codes. The first1-hour outcome cannot appear before an hour has elapsed from the first snapshot;24-hour evaluation requires a full day and sufficient actual candles. Successful source/network probes do not establish predictive performance.

## Admin view

Set `ADMIN_FOMO_EVALUATION_DB` on the admin process to the existing SQLite trade database. The authenticated sidebar **FOMO: снимки и цены** displays point-in-time captures,1/6/24h maturity, saved gross returns and OHLC drawdown, unknown/partial feature coverage and price failure codes. The **Свечи и источник** button opens retained price evidence with source/unit/pool/orientation metadata and SHA-256 references. The page refreshes every minute unless an evidence detail is open. Reads use a consistent read-only SQLite transaction; no database is created when configuration is missing. Labels are repeated observations per token, not independent trading profits.

### Descriptive score analysis in admin

The report fixes the first40 completed1h results by `(completed_at,snapshot_id)` for the local PG score version and shows expansion separately(up to5000). It does not mix versions or horizons. Rank correlations use average ranks for ties; constant/small samples produce null. One earliest evaluable snapshot per token and leave-one-token-out ranges disclose dependence and concentration; these are not independent-market controls or significance tests. Fixed descriptive bins are not fitted entry thresholds. Opposite-return examples match the same token and scores/coverage(to8decimals) and link to original price evidence. Missing-price selection bias, partialTG-onlyQualitycoverage, absent costs/marketbaseline and lack of future holdout remain explicit. No predictive-performance claim.

### All stored trades in token AI

Token requests compute all stored records as of the request, under one SQLite read transaction. Full aggregates,top5wallets and20illustrative trades reach the model; the100rowrawreference limit does not limit aggregates. The source digest includes every qualifying row. A changed older row invalidates the request cache. No partial aggregate is served if the100000rowlimit is exceeded. Returned findings select only application-verified observations; recordedBUY−SELL is notPNL or liquidity. The complete frozen archive stays in the analysis report and is stripped before API/cache responses. The authenticated admin report offers hash-checkedJSONL download: firstline `["stored-chain-v1", mint]`, then arrays with columns `signature,timestamp,trader,type,amount_sol,amount_tokens,price_sol,slot,inserted_at`. Its entire file SHA-256 equals the displayed datasetHash. Coverage means all stored rows at that cutoff, never the full blockchain.
