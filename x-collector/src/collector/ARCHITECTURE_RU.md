# X Collector: module boundaries (local laptop)

X Collector code is split into six canonical modules under `src/collector/`.
The public API is `src/collector/index.ts`, which exports each module as a
namespace. All legacy paths still exist as **compatibility re-exports**.
This migration is a code reorganization, not a database schema change, server
deployment or change of collection permissions.

```text
src/collector/
  accounts/
    account-manager.ts    # SQL-fenced account claims, quotas, cooldowns, proxy identity
    index.ts
  queue/
    tasks.ts              # PostgreSQL claims, leases, retries, DLQ
    task-status.ts        # Read-only task display state and safe error codes
    index.ts
  engines/
    browser.ts            # Playwright collection, paging and batch callbacks
    search-diagnostics.ts # Credential-free search DOM diagnosis
    index.ts              # Also exposes existing src/x and src/xactions engines
  persistence/
    collector-store.ts    # Atomic tweet/profile persistence and lease fencing
    index.ts              # Existing historical persistence remains shared
  monitoring/
    live.ts               # SSE polling and progress writes
    task-dashboard.ts     # Bounded queue snapshots
    error-report.ts       # Allowlists and aggregate error counts
    index.ts
  runtime/
    collector-task.ts     # Executes a leased task through an engine
    worker-runtime.ts     # Worker lifecycle state
    worker-registry.ts    # Heartbeats and worker counters
    db-recovery.ts        # Cancellable PostgreSQL reconnect
    index.ts
  index.ts
```

## Imports and compatibility

New collector code should import from the six namespace boundaries, e.g.:

```ts
import { claimTasks, deferTask } from "../src/collector/queue";
import { executeTask, WorkerRegistry } from "../src/collector/runtime";
import { activeTaskSnapshot } from "../src/collector/monitoring";
```

Relative paths vary by caller location. The main worker, collection HTTP
adapter, dashboard and error CLI are already routed through these boundaries.
Old paths (such as `lib/trade/tasks.ts`, `lib/trade/twitter-scraper.ts`,
`src/runtime/collector-task.ts`) only re-export the canonical symbol, so
existing tests and external callers do not instantiate a second queue or live
SSE polling singleton. Regression tests enforce reference identity.

## Ownership and restrictions

- `accounts` owns session/account selection and proxy failure cooldown;
  `queue` owns durable task claims. Both enforce PostgreSQL lease fencing.
- `engines` reads X using Playwright or **opt-in** XActions. The XActions HTTP
  implementation stays in `src/xactions/` for backwards compatibility; it is
  surfaced through the engines boundary, not copied.
- `persistence` stores the observed data with task/account leases. Archive and
  historical data facilities remain shared; do not copy or duplicate writes.
- `monitoring` formats safe diagnostics; the original `lib/collector/http.ts`
  is an HTTP adapter, not a second implementation of monitoring.
- `runtime` coordinates cancellation, worker status, task execution and
  database recovery. The CLI worker in `scripts/worker.ts` remains the
  supported laptop entrypoint.
- Analytics are independent: `src/intelligence/` and `lib/intelligence/`.
  Reply Guy remains separate in `lib/reply/` and `scripts/reply/`.
  They share database infrastructure, but not collector orchestration.

## Validation

Run from `x-collector`: `npm run typecheck && npm test && npm run build`.
`tests/collector-modules.test.ts` checks new/legacy import identity, bounded
proxy identity semantics and diagnostics filtering. No migration is required.

CI is offline. Real X account, SOCKS5 and local PostgreSQL stop/restart still
require a controlled laptop test; green CI does not prove X feed completeness.
