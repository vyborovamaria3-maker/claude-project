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
Versioned derived scoring / backtests
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

`backtest` is an offline deterministic scoring regression. It does not open SQLite/PostgreSQL or call a provider.

`score` evaluates one persisted GitHub evidence document at an explicit timezone-aware `--as-of` time. Requiring `--as-of` keeps audits and historical runs reproducible.

## Evidence integrity and derived scoring

Normalized evidence and derived scores are deliberately separate concerns.

`raw_hash` fingerprints only stable evidence identity fields:

- source;
- URL;
- author;
- normalized content.

Derived score values are **not** included in the evidence hash. This prevents score/version/recency changes from turning unchanged evidence into a new document.

If a document carries `raw_hash`, every storage backend validates the fingerprint before persistence and again when evidence is read. A content/source/URL/author change with a stale fingerprint is rejected instead of silently entering a backtest.

The first versioned derived score is:

```text
github-developer-v1
```

It returns both a numeric score and stable reason codes. Golden fixtures carry their expected score version and fail fast if the runtime formula version changes without a corresponding fixture review.

Historical scoring rejects evidence whose repository `created_at` or `updated_at` is newer than the requested evaluation time. This prevents look-ahead bias in backtests.

Persisted GitHub evidence is scored only when its repository entity and canonical `https://github.com/owner/repo` URL agree. Scoring does not mutate normalized evidence or `raw_hash`.

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

## Verification

Unit tests are network-free by default. `test_postgres_integration.py` is automatically skipped unless `POTAPOFF_TEST_POSTGRES_DSN` is supplied.

The Intelligence CI is configured to run against a disposable PostgreSQL service and verify:

- compile/unit tests;
- deterministic scoring golden backtest;
- evidence fingerprint integrity on storage boundaries;
- schema initialization;
- document round-trip and `raw_hash` deduplication;
- two concurrent `SKIP LOCKED` queue claims;
- a separate admin role that can `SELECT` but cannot `INSERT`;
- Docker Compose validation;
- non-root/read-only worker image smoke checks;
- scoring backtest from inside the worker image;
- `yt-dlp` and Deno availability;
- HIGH/CRITICAL image vulnerability scan.

The PR must remain draft until those checks actually execute successfully.
