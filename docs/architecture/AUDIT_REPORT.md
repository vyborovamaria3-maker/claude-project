# Confirmed baseline findings

| Priority | Evidence | Impact | Fix |
|---|---|---|---|
| P1 | tasks.ts: extendLease/finishTask/failTask/deferTask check owner but not lease expiry or attempt | Expired execution may renew/acknowledge; reused worker IDs permit stale attempt updates | Expiry guards, attempt fencing, unique instance IDs |
| P1 | worker.ts opt-in branch uses getCollectorAccount SELECT, bypassing pickAccount | Concurrent session use; quota bypass | Route both paths through existing reservation |
| P1 | collector-store.ts calls processTweetEntities inside tx; processor starts another tx | Partial commit, FK visibility failures on real PostgreSQL, pool exhaustion | Use the supplied PoolClient |
| P1 | account-manager.ts bans after repeated rate limits/captcha; worker maps session expiry to ban | Unsupported account status inference | Keep rate limits in cooldown, session/captcha require intervention |
| P1 | WorkerRegistry reaper expires valid leases on stale heartbeat | Network delay can trigger duplicate work | Heartbeat is diagnostic; task lease alone controls recovery |
| P2 | scheduler.ts closes pool while scheduled work is active | Shutdown interrupts transactions | Stop scheduling, drain tracked tasks with deadline |
| P2 | worker registry resets counter buffers before successful write | Metrics lost on DB failure | Serialize flush and restore counts on failure |
| P2 | Dockerfile omits src and required CJS dependencies of compiled scripts | Build/runtime import failures | Copy source and runtime helper files |
| P2 | src/jobs/handlers/router.ts returns ready status without operation; unused | Misleading alternative job API | Remove unused scaffold, use actual claimed task types |
| P2 | logger scrubs fields but arbitrary error strings can contain URL credentials | Credentials in logs/DLQ | Redact common credential string patterns |

Remaining audit scope: launcher distributed process management, global API quotas, long-term archive retention, all unrelated products, full deployment/load tests. No performance improvement claim without measurement.
