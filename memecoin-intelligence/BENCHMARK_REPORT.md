# Benchmark report — v3.2.0

Benchmarks were run locally with generated data and without any paid X/Twitter API.

## Streaming dataset test

Dataset:

- 100,000 posts
- 10,000 accounts
- 1,000 tokens
- 18.05% coordinated ground-truth posts

Results:

- feature extraction: **61,444 posts/second**
- feature extraction time: **1.63 seconds**
- network sample: **5,000 posts / 3,959 unique accounts**
- candidate pairs: **241,844** of **7,834,861** possible pairs
- pair comparisons pruned: **96.91%**
- network analysis time: **2.40 seconds**
- process RSS after benchmark: **about 285 MB**

The mixed-token network sample is intentionally harsher than a normal token search, because it combines many independent campaigns in one graph.

## v3.1.0 versus v3.2.0 network comparison

Identical first 1,500 generated posts:

| Metric | v3.1.0 | v3.2.0 | Change |
|---|---:|---:|---:|
| Unique accounts | 1,413 | 1,413 | same input |
| Network time | 3,998 ms | 740 ms | **5.4× faster** |
| RSS memory | 332.6 MB | 141.3 MB | **57.5% lower** |
| Pair strategy | all pairs | indexed candidates | architectural change |
| Candidate pairs | ~997,578 implicit | 59,919 | **94.0% pruned** |

The number of retained edges differs because v3.2.0 removes weak all-pairs correlations and only scores accounts that share an indexed evidence bucket.

## Validation

- TypeScript syntax transpilation: passed for 52 files.
- Network regression tests: passed.
- Server/tools semantic typecheck with dependency stubs: passed.
- Full `npm install` could not run in the execution environment because its internal npm mirror does not contain `@fastify/cors`. This is an environment registry limitation, not a source-code failure.
