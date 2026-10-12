# Local setup

Use Node >=20 (verified locally with Node 24 and Docker Node 22). From x-collector:

```powershell
npm ci
npm run install-browser
Copy-Item .env.example .env
```

Set DATABASE_URL to a dedicated PostgreSQL database and MASTER_KEY to a permanent random 32-byte hex key. Set DASHBOARD_USER and DASHBOARD_PASS before any state-changing Dashboard action, including on loopback. Keep credentials outside version control. Configure account policies to permitted usage; defaults are application policy, not a guarantee of X API quotas.

```powershell
npm run migrate
npm run login -- --help
npm run worker
# separate terminals:
npm run scheduler
npm run dashboard
```

Existing login/import/register commands remain documented in x-collector/README.md. Use only authorized accounts. Expired sessions require renewed login; compatible `captcha` status now denotes login or manual verification required. A rate limit produces cooldown, never inferred account ban.

Settings: WORKER_ID is a label prefix (UUID always appended), WORKER_SHUTDOWN_MS defaults 30000, COLLECTOR_MAX_BACKLOG defaults 10000 (0 disables the guard), TEST_CONCURRENCY defaults 4. One active job per worker. Use distinct METRICS_PORT values for local workers, or 0 when no fixed health port is needed. Non-loopback worker/dashboard bindings retain mandatory credentials/origin protection.

```powershell
npm run jobs:dlq -- list
npm run jobs:dlq -- list 123
npm run jobs:dlq -- replay 123 1
```

Replay only after fixing the cause. Original task/results/idempotency key are retained; max total attempts cannot exceed 100. Backpressure rejects and rolls back overflowing insert batches; producers should retry later, not spin.

Scheduler defaults to two concurrent tasks and coalesces duplicate ticks while waiting. Each task needs an advisory-lock connection plus query capacity; set PG_POOL_MAX >=3 and SCHEDULER_CONCURRENCY <= floor((PG_POOL_MAX-1)/2). Queued ticks are discarded on shutdown and running tasks are drained. Migration 038 repairs BIGINT day-duration arithmetic in existing analytics functions; run npm run migrate before restarting the scheduler.

For a local Celery Beat authentication failure, compare its broker configuration with the working worker and RabbitMQ. Synchronize the local .env RabbitMQ settings, then recreate only celery-beat using the same Compose files as the running stack. Restarting an unchanged container does not update its environment. Keep credentials out of Git.

# Docker

The existing compose.reply.yml has a collector profile. In .env set REPLY_DB_PASSWORD, MASTER_KEY, DASHBOARD_USER, DASHBOARD_PASS and DASHBOARD_ORIGIN=http://127.0.0.1:3001 (adjust for the secured browser origin).

```powershell
docker compose -f compose.reply.yml --profile collector up --build -d postgres migrate worker scheduler dashboard
docker compose -f compose.reply.yml ps
docker compose -f compose.reply.yml logs --tail 100 worker scheduler
```

The explicit service list avoids starting unrelated reply services. PostgreSQL has no host port; Dashboard binds host loopback. Docker worker/scheduler run externally to Dashboard (COLLECTOR_AUTOSTART=false), and should not also be started from the launcher's local process buttons. Use Docker commands to manage them. Data/logs use persistent volumes, migration completion gates collector startup, browser is installed in the image, process runs as node with init/restart policy. A Docker healthcheck reports readiness; it is not a standalone hung-process restarter.

# Verification

```powershell
npm run typecheck
npm run lint
npm test
npm run build
# On an explicitly disposable *_test database:
$env:RUNTIME_TEST_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:PORT/x_collector_test'
npm run test:db
```

Integration tests create/drop isolated schemas and require explicit test DB configuration. No live X or LLM call is required by regression tests. Preserve backups of PostgreSQL and MASTER_KEY before deployment; losing the key makes encrypted sessions unreadable.
