# X collector

This is the PostgreSQL X collector from fixed_project.zip, integrated as an isolated subsystem. It does not replace the existing SQLite collector inside solana-launcher.

## Migrations

The complete 001–011 migration chain is included. Migration 003_performance.sql was reconstructed from the collector's surviving query patterns; it adds indexes and is not a byte-for-byte recovery of the missing original. Do not substitute migrations from other subsystems. The runner validates the chain and prevents concurrent migration runs. Use `npm run x-collector:migrate -- --status` to inspect migration status.

## Setup

Use a dedicated PostgreSQL database named x_collector. Do not point this service at the main application database. The existing memecoin-intelligence PostgreSQL publishes port 5434; create a separate x_collector database there (or use another dedicated PostgreSQL instance), then copy .env.example to .env and set DATABASE_URL plus a permanent random 32-byte MASTER_KEY (64 hexadecimal characters or Base64). Keep the .env file and key out of Git. Losing or changing MASTER_KEY makes stored X sessions unreadable.

From the repository root:

~~~powershell
npm run x-collector:install
npm run x-collector:install-browser
npm run x-collector:migrate
npm run x-collector:login -- analyst1
npm run x-collector:search-mints -- --input data\solana-mints.txt --limit 100 --sort latest
npm run x-collector:worker
~~~

Quality checks (no database required):

~~~powershell
npm run x-collector:typecheck
npm run x-collector:lint
npm run x-collector:test
~~~

The mint file accepts one Solana address per line; blank lines and lines starting with # are ignored. The importer validates and deduplicates addresses, then queues one X search per mint. Start scheduler, dashboard and outbox publisher in separate terminals with x-collector:scheduler, x-collector:dashboard and x-collector:publisher.

Quality checks are wired up from the repository root:

~~~powershell
npm run x-collector:typecheck   # tsc --noEmit
npm run x-collector:lint        # eslint
npm run x-collector:test        # node:test via tsx (tests/**.test.ts)
~~~

Unit tests cover the shared parsing/CSV/auth/advisory helpers and do not require a database or a running collector.

Dashboard and metrics bind to loopback by default. External binds require Basic Auth and TLS at a reverse proxy. X login restrictions, captcha challenges and rate limits are surfaced as failures; the collector does not rotate identities to evade a platform restriction. Results are bounded by X search availability and configured limits, so the collector cannot guarantee every account or historical post.

Timeline refreshes store posts without linking every post to the mint that originally led to the account. Only search results explicitly queued for a mint create tweet-to-mint links.

The archive report is retained as FIX_REPORT_RU.md. It describes the supplied source snapshot and its verification limits.

Dashboard CSP permits only the pinned Vue and Chart.js CDN script URLs used by its HTML. Internet access to these CDNs is required. HTTP rate limits use the socket peer address and ignore untrusted forwarded headers. Behind a reverse proxy, the application limit is shared by requests from that proxy; configure per-client limits at the proxy too.

## Graph signals and autonomous monitoring v1

Apply migration 012 with `npm run migrate` inside x-collector before starting the scheduler.
`npm run monitor` runs one cycle; the scheduler runs it every five minutes. No new
AI, sentiment, embeddings, dashboard or trading features are used by this cycle.

The analyzer reads posts, entity mentions with confidence >= 0.5, explicit token
links and author reputation. Missing reputation contributes zero. It compares two
adjacent completed hourly windows. Duplicate tweets and repeated entity mentions
contribute once; author handles are normalized. Posts with missing timestamps and
future posts are excluded. Entity identifiers preserve type and value.

Base score: frequency (30), positive growth (30), unique authors (20), posting
velocity (20), each bounded. Final score = base * 0.60 + author reputation * 0.25
+ graph impact * 0.15. Graph impact combines author diversity (70%) and distinct
co-mentioned entities (30%). Scores are evidence of attention, not price predictions.
LOW <30; MEDIUM >=30; HIGH >=60; CRITICAL >=80.

History is stored in graph_signal_history. HIGH/CRITICAL observations also create
graph_priority_events with priorities 2/3. These are persisted events for consumers,
not externally delivered notifications. Transactional advisory locking serializes
cycles, REPEATABLE READ fixes the input snapshot, and unique keys deduplicate
entity/window records. Failed cycles roll back; successful windows remain immutable.
Late posts arriving after the first successful cycle are not retroactively included.

Inspect results with:
```sql
SELECT entity, bucket_at, score, level, payload
FROM graph_signal_history ORDER BY bucket_at DESC, score DESC LIMIT 100;
SELECT * FROM graph_priority_events ORDER BY priority DESC, created_at DESC LIMIT 100;
```

Real PostgreSQL integration check: set TEST_DATABASE_URL to a dedicated test database, then run `npm run test:db` inside x-collector. It creates and removes an isolated schema and checks persistence, duplicate protection, concurrent locking and rollback. Without TEST_DATABASE_URL the check is skipped.
