# Solana Launcher — wallet summary operations

## Read/write boundary

`GET /api/database/wallets` is now a read-only query path. It never creates the aggregate schema or rebuilds the wallet summary. If the summary is absent or its source signature is stale, the route returns HTTP 409 with code `WALLET_SUMMARY_STALE`.

The expensive rebuild is an explicit operator/import operation:

- `npm run migrations:import` rebuilds the wallet summary once after the XLSX batch completes.
- `npm run wallet-summary:rebuild` rebuilds it from the current SQLite source data without re-importing XLSX files.
- `npm run wallet-summary:test` runs the in-memory regression for aggregate values, revision invalidation and idempotency.

The rebuild uses an IMMEDIATE SQLite transaction. It acquires the write lock before checking the source signature, so two concurrent rebuild processes do not both rebuild the same revision.

## Manual rebuild against the production bind mount

The production frontend container mounts `$DEPLOY_DIR/data` at `/app/data`. The SQLite file remains server-side; the browser never receives direct access to it.

Before a manual rebuild, take and verify a backup. Then use a trusted checkout with the locked Solana Launcher dependencies already installed:

```bash
cd /opt/claude-project/solana-launcher
SOLANA_TRADE_DB_PATH=/opt/potapoff-deploy/data/trade.db npm run wallet-summary:rebuild
```

Adjust `DEPLOY_DIR` if the deployment uses a different path. Do not run `npm ci` or alter the production volume as an improvised recovery step during an active deployment.

## Deployment readiness probe

`GET /api/internal/health/wallet-summary` requires the server-only `x-internal-service-key` header. It returns only readiness:

- HTTP 200: summary is current.
- HTTP 503: summary is stale or not initialized.
- HTTP 401: missing or invalid internal service key.

It does not return wallet rows, addresses, aggregate values, source signatures or filesystem paths. `healthcheck-production.sh` uses this endpoint before declaring a deployment healthy.

## SQLite constraints that remain

- `lib/trade/db.ts` configures WAL, `busy_timeout = 5000` and initializes schema once per module/process rather than on every `getDb()` call.
- The admin-site reader uses SQLite read-only mode and `PRAGMA query_only=ON`.
- The Next.js server still owns the write-capable SQLite connection. Do not horizontally scale frontend replicas against the same SQLite file. A move to a single-writer service or PostgreSQL requires a separate migration plan.
- Other read-only Next.js routes may still use the shared write-capable connection; converting every query path to a dedicated read-only connection remains separate work.
