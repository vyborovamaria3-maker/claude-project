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
- Task errors now distinguish unverified empty search, pagination ambiguity,
  source shape change, SOCKS5 connection error and collection timeout.
- Proxy/collection failures are no longer recorded as evidence that an X
  account has a broken authenticated session.

## Operator checks

1. Run the migration check and existing local collector tests before switching
   to this branch; keep a PostgreSQL backup. No new SQL migration is required
   by this patch.
2. Run `npm run typecheck && npm test && npm run build` from `x-collector`.
3. In a controlled local test, stop PostgreSQL while the worker is idle. The
   worker must become DEGRADED, stay alive, and return to READY when SQL is
   restored; the same job must not be claimed by two live workers.
4. Stop the collector with its normal IPC stop during a database outage. It
   should finish shutdown without a retry loop hanging indefinitely.
5. In the task-error logs compare rolling 1h/24h error counts with the
   historical total. Existing rows are not rewritten or reclassified.

## Outstanding work (not claimed complete by this patch)

- Dedicated SOCKS5 health/circuit-breaker and per-proxy statistics.
- Visual search evidence capture (redacted DOM/screenshot) for the 132
  historical unconfirmed searches; verify current X selectors in the user's
  authenticated sandbox.
- Native browser list end-of-feed evidence; do not equate stagnant scrolling
  with complete source coverage.
- Rich task states (waiting/partial), account-state explanations and monitoring
  dashboard improvements.
- Live end-to-end regression against a test X account, real proxy and database,
  followed by laptop memory/throughput benchmarks.

Historical failure counts must not be presented as current failure rates.
