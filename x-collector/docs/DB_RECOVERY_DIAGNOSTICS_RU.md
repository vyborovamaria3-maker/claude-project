# X Collector: PostgreSQL outage recovery and XActions error diagnosis

Scope: local Windows laptop, existing PostgreSQL collector queue; no separate server.
These changes do not alter X platform limits or allow bypassing restricted accounts.

## Actual changes

- Worker remains STARTING until idempotent registration succeeds. A transient
  connection/refusal/pool acquisition timeout retries with capped jittered backoff.
- After a transient claim/DB failure, worker reports DEGRADED and re-registers
  before returning to READY. IPC stop cancels recovery promptly.
- Unexpected SQL errors such as missing migrations are NOT retried forever.
- Existing task leases, PostgreSQL atomic queue claims and transactional page
  checkpoints are retained; no job COMMIT is blindly replayed.
- PostgreSQL COMMIT failure with an uncertain outcome now raises
  AmbiguousCommitError, **including Node connection errors such as ECONNREFUSED
  reported only in error.code**. The connection is discarded, not pooled.
  Server-confirmed SQLSTATE 40001/40P01 aborts can still retry.
- Unverified empty user timelines now have distinct retryable diagnostics
  instead of assuming an X account was restricted.
- Concurrent /health queries share a single outstanding PostgreSQL probe.
  A slow or unavailable database can still return HTTP 503, but repeated
  checks no longer accumulate a growing pile of timed-out pool queries.
- Task errors now distinguish unverified empty search, pagination ambiguity,
  source shape change, SOCKS5 connection error and collection timeout.
- Proxy/collection failures are no longer recorded as evidence that an X
  account has a broken authenticated session.
- Failed SOCKS5 endpoints trigger a lease-fenced 60-second cooldown for
  collector accounts with the same normalized SOCKS5 endpoint AND credentials;
  dynamic probe metadata and timestamps do not affect grouping. This is not a general per-endpoint monitor.
- XActions full HTTP request timeouts and oversized/invalid responses are
  classified separately from SOCKS5 failure, without raw agent errors.
- Browser feed crawling keeps saved post batches and treats short, stalled
  nonempty pages as a bounded observation with unverified end evidence, not a
  task failure; periodic list/discovery sources remain schedulable.
  An empty feed still reaches the caller for explicit empty-state diagnosis.
- A read-only local report (`npm run x:errors`) shows 1-hour and 24-hour
  task-error snapshots, timestamped account-error events, and queue/account
  counts; those are **different measures** and must not be added together.
  Up to 50 pending/claimed tasks include safe derived statuses:
  queued, waiting_account, retry_wait, running, and partial.

## Account reservation and diagnostics fixes

- A PostgreSQL outage before a task starts no longer gets silently swallowed
  by the worker. The task is fenced-deferred after DB recovery, without
  consuming an X attempt; ordinary runtime crashes follow bounded retry/DLQ.
- An uncertain account claim COMMIT is reconciled through the unique
  account lease owner after recovery, releasing only that reservation and
  refunding its unused quota without touching a different worker.
- Periodic source short pages do not go into permanent partial state. The
  source checkpoint still says X completeness is not guaranteed.
- Live SSE, task details, and local CLI expose only allowlisted error codes;
  untrusted bracketed legacy error text is mapped to LEGACY_OR_UNKNOWN.
- Queue states prioritize wait/retry while saved partial output is a separate
  flag.

## Operator checks

The standalone historical producer also reconnects its dedicated PostgreSQL
session after idle disconnects or transient startup failures. It closes the
broken session, reacquires advisory lock 742098534 and reads durable progress
before the next cycle. It never replays individual ambiguous transactions.
Shutdown interrupts reconnect backoff; schema/configuration errors remain fatal.
Tests terminate only the producer connection in a dedicated test database,
without stopping the user's PostgreSQL service.

1. Run the migration check and existing local collector tests before switching
   to this branch; keep a PostgreSQL backup. No new SQL migration is required
   by this patch.
2. Run `npm run typecheck && npm test && npm run build` from `x-collector`.
3. In a controlled local test, stop PostgreSQL while the worker is idle. The
   worker must become DEGRADED, stay alive, and return to READY when SQL is
   restored; the same job must not be claimed by two live workers.
4. Stop the collector with its normal IPC stop during a database outage. It
   should finish shutdown without a retry loop hanging indefinitely.
5. Run `npm run x:errors` to compare the 1h/24h snapshots and event counters.
   Existing rows are not rewritten or reclassified, and snapshot counts
   are not a complete historical error-event series.

## Outstanding work (not claimed complete by this patch)

- Dedicated shared SOCKS5 health/circuit-breaker and per-proxy statistics
  (account-bound cooldown is implemented, but not a shared proxy breaker).
- Visual search evidence capture (redacted DOM/screenshot) for the 132
  historical unconfirmed searches; verify current X selectors in the user's
  authenticated sandbox.
- Verified X browser end-of-feed evidence remains unavailable for feeds without
  an explicit end marker. Stalled nonempty pages no longer block recurring
  sources; do not equate a successful bounded sample with complete X coverage.
- Detailed evidence-grade coverage states, account-state explanations and
  expanded multi-period monitoring; task wait/retry and persisted-output status
  are now separate in the local dashboard.
- Live end-to-end regression against a test X account, real proxy and database,
  followed by laptop memory/throughput benchmarks.

Historical failure counts must not be presented as current failure rates.
