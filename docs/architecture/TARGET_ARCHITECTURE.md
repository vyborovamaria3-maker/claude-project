# Implemented runtime shape

PostgreSQL remains the only durable queue/account authority. No Redis/BullMQ or new service.

Scheduler -> enqueueTask(s) with atomic backlog cap -> existing x_tasks -> scripts/worker.ts -> WorkerRuntime -> reusable src/runtime/collector-task.ts -> existing real collectors -> fenced collector-store transaction -> tweet/profile/archive/raw intelligence tables -> existing normalization workers and Dashboard.

The entrypoint retains auth, metrics, heartbeat and process shutdown. Runtime exposes lifecycle/current attempt/counters; concurrency is one per worker, with separate processes for scaling. WorkerRegistry remains the existing durable heartbeat implementation. Alternative search uses the same account reservation and shared logger. The unused synthetic router and non-atomic account manager/repository scaffold were removed after confirming no callers.

Critical persistence checks task owner, attempt and live account lease while holding task/account rows. Entity writes share the result transaction. Task acknowledgement follows successful persistence; crashes between result commit and acknowledgement retry idempotent writes. PostgreSQL timestamps plus host clock synchronization are operational assumptions for epoch-based leases.

Local launcher process control is unchanged. The existing Compose gains a collector profile, disables Dashboard autostart there and uses Docker restart policies. Local Dashboard autostart is serialized by a PostgreSQL advisory lock. It does not expose a Docker socket.
