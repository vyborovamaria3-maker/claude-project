# Implementation sequence

1. Preserve actual collectors/DB tables; stabilize lease transitions and persistence atomicity.
2. Integrate lifecycle into existing worker and account reservation into both search paths.
3. Drain scheduler, repair registry diagnostics/counters, redact error strings.
4. Regression/failure tests, real PostgreSQL concurrency where available, strict checks/build/lint.
5. Deliver full sanitized source ZIP and explicit verification/remaining scope.

No schema migration or Redis required for these fixes. Existing API statuses remain compatible. Rollback by deploying the original archive after draining processes; no destructive DB changes.
