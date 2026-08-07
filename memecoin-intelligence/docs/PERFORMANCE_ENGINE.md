# v3.2.0 Ultra Performance Engine

## What changed

- Indexed candidate generation replaces the account all-pairs graph comparison.
- Exact fingerprints, contracts, links, tickers, hashtags, rare words, direct mentions and time windows create candidate blocks.
- A configurable candidate budget prevents one viral token from exhausting RAM.
- Post features are extracted once and stored in `post_features`.
- Fixture data is parsed once per file modification and has an in-memory inverted index.
- Redis caches completed analyses and collapses duplicate in-flight requests.
- PostgreSQL ingestion uses chunked `unnest` upserts instead of one query per row.
- BullMQ has separate queues for ingestion, features, graph, scoring and complete analyses.
- NDJSON stress generation and streaming benchmarks avoid loading the entire dataset into memory.

## Complexity

The old graph path compared every account with every other account: `n * (n - 1) / 2` comparisons.
The new graph path only compares accounts sharing at least one useful index bucket. API results expose:

- `candidatePairCount`
- `possiblePairCount`
- `pruningRatio`
- `analysisMs`

This makes regressions measurable.

## Benchmark

```bash
npm run benchmark:small
npm run benchmark:medium
```

The generator writes NDJSON to `fixtures/generated/`. The benchmark streams the file, extracts every feature, then runs network analysis on a controlled sample. Results are written to `benchmark-report.json`.

Compare two runs:

```bash
npm run benchmark:compare -- baseline.json benchmark-report.json
```

## Production knobs

- `DB_POOL_MAX`
- `INGEST_BATCH_SIZE`
- `WORKER_CONCURRENCY`
- `ANALYSIS_MAX_CANDIDATE_PAIRS`
- `ANALYSIS_MAX_FEATURE_FANOUT`
- `ANALYSIS_TIME_BUCKET_MINUTES`
- `SEARCH_CACHE_SECONDS`

Increase values gradually while watching RSS memory, PostgreSQL locks and queue latency.
