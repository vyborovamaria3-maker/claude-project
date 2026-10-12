# Collector dependencies

- scripts/worker.ts -> tasks, account-manager, WorkerRegistry, scraper, schemas, collector-store, history-filter, metrics, auth.
- scheduler -> tasks, advisory lock, analytics/graph SQL functions.
- collector-store -> pg tx, entities processor, archive store, intelligence-store.
- task-handler -> encrypted session/proxy -> searchX -> Playwright parser.
- dashboard -> analytics, tasks/worker reads, authenticated collector controls.
- launcher lib/xcollector.ts -> local collector scripts and HTTP health probes.
- intelligence worker -> shared PostgreSQL raw-event normalization.
- PostgreSQL is authoritative for tasks, accounts, results, history and raw AI events. In-memory timers are coordination only.
- Existing libraries: pg, Playwright, zod, prom-client, proxy agents, dotenv; PGlite/Node test for verification. No added queue broker.
