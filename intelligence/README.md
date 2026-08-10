# POTAPoff Intelligence Layer

Isolated off-chain intelligence collection and operational telemetry for POTAPoff.

## Providers

Current:

- GitHub public repository intelligence;
- Web via Jina Reader;
- RSS 2.0 / Atom;
- YouTube metadata and optional transcripts via `yt-dlp`.

Future providers such as X/Reddit should be added only after the foundation is fully verified.

## Runtime architecture

```text
Providers
   |
ProviderRegistry
   |
Durable JobQueue
   |-- SQLite WAL (single-host)
   `-- PostgreSQL SKIP LOCKED (multi-worker)
   |
IntelligenceWorker
   |
DocumentStore
   |-- Memory
   |-- SQLite WAL
   `-- PostgreSQL JSONB
   |
Read-only Control Center telemetry
```

The intelligence layer must never contain trading keys, wallet secrets or unrelated private application credentials.

## CLI

```bash
python -m intelligence --help
python -m intelligence init-db
python -m intelligence runtime-health
python -m intelligence doctor
python -m intelligence backtest
python -m intelligence score DOCUMENT_ID --as-of 2026-08-10T00:00:00+00:00
python -m intelligence enqueue github owner/repository
python -m intelligence run-once
python -m intelligence worker --poll-seconds 2
python -m intelligence job JOB_ID
python -m intelligence documents --limit 50
```

`runtime-health` performs harmless point reads against both durable queue and document storage. It does not claim jobs or call external providers.

## Reproducible verification

Verification logic lives in the repository instead of being duplicated inside GitHub Actions.

Run the network-free core profile from any working directory:

```bash
python3 scripts/verify_intelligence.py
```

It runs compilation, intelligence unit tests, deterministic scoring backtests, admin intelligence integration tests, secret-template validation and credential-file checks.

For a disposable test environment with Docker and separate PostgreSQL writer/read-only test roles:

```bash
export POTAPOFF_TEST_POSTGRES_DSN='postgresql://WRITER_TEST_ROLE:.../intelligence'
export POTAPOFF_TEST_POSTGRES_READONLY_DSN='postgresql://READONLY_TEST_ROLE:.../intelligence'
python3 scripts/verify_intelligence.py --full
```

`--full` additionally executes the live PostgreSQL integration harness, rendered Compose secret-boundary validation and the hardened worker-image smoke tests. It never creates or alters PostgreSQL roles; provisioning disposable test roles remains an explicit external setup step so the verifier cannot accidentally mutate production permissions.

GitHub Actions invokes this same `--full` entrypoint. A GitHub-hosted runner failure therefore does not require a different validation path: the exact application verification contract can be executed locally or on a controlled server.

## Versioned scoring / backtesting

The current GitHub developer score version is `github-developer-v1`.

Scoring is derived from persisted normalized evidence and does not alter evidence content or `raw_hash`. Historical scoring requires an explicit timezone-aware `--as-of` value. The scorer rejects future snapshot timestamps to prevent look-ahead bias.

The golden fixture backtest pins:

- score version;
- fixed historical `as_of` timestamps;
- expected score ranges;
- required stable reason codes.

Evidence carrying a `raw_hash` is re-fingerprinted before persistence and again when loaded from Memory/SQLite/PostgreSQL storage. A mismatched fingerprint is rejected instead of entering a historical backtest.

## SQLite deployment

SQLite is the default single-host backend.

Worker environment (`admin-site/.env.intelligence`):

```text
POTAPOFF_INTELLIGENCE_BACKEND=sqlite
POTAPOFF_INTELLIGENCE_POSTGRES_DSN=
```

The worker owns the writable intelligence volume. The admin container mounts that volume read-only and opens SQLite using read-only/query-only mode.

## PostgreSQL deployment

PostgreSQL is the multi-worker backend.

Before starting workers, initialize the idempotent schema with the **worker** DSN:

```bash
python -m intelligence \
  --backend postgres \
  --postgres-dsn "$POTAPOFF_INTELLIGENCE_POSTGRES_DSN" \
  init-db
```

Then configure two different database roles.

Worker-only file `admin-site/.env.intelligence`:

```text
POTAPOFF_INTELLIGENCE_BACKEND=postgres
POTAPOFF_INTELLIGENCE_POSTGRES_DSN=postgresql://WORKER_ROLE:.../intelligence
```

Admin file `admin-site/.env`:

```text
ADMIN_INTELLIGENCE_BACKEND=postgres
ADMIN_INTELLIGENCE_POSTGRES_DSN=postgresql://READONLY_ROLE:.../intelligence
```

The admin role must have only `CONNECT`, schema `USAGE` and `SELECT` on intelligence tables. Do not reuse the worker DSN as the admin DSN.

## Secret boundary

`admin-site/.env` is loaded only by the admin service.

`admin-site/.env.intelligence` is loaded only by the intelligence worker and is gitignored. Copy it from `.env.intelligence.example` on the server.

Do **not** copy the complete admin `.env` into the worker, and do **not** put the worker PostgreSQL DSN into the admin `.env`.

## Operational safety

- worker container runs non-root;
- root filesystem is read-only;
- Linux capabilities are dropped;
- `no-new-privileges` is enabled;
- no public worker port is exposed;
- durable runtime failures use bounded retry/backoff;
- unknown implementation errors are not silently swallowed;
- CLI and Control Center telemetry omit raw evidence content and sensitive provider/query/error details.

## Verification gates

Unit tests are network-free by default. `test_postgres_integration.py` is automatically skipped unless `POTAPOFF_TEST_POSTGRES_DSN` is supplied.

The full repository verifier covers:

- schema initialization through the live PostgreSQL harness;
- document round-trip and `raw_hash` deduplication;
- two concurrent `SKIP LOCKED` queue claims;
- a separate admin role that can `SELECT` but cannot `INSERT`;
- deterministic scoring backtest;
- Docker Compose validation and rendered credential separation;
- non-root/read-only worker image smoke checks;
- `yt-dlp` and Deno availability.

CI adds a final Trivy HIGH/CRITICAL image vulnerability scan after the repository verifier succeeds.

The PR must remain draft until the required checks actually execute successfully.
