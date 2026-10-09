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

The standard `npm test` also uses the embedded PostgreSQL engine PGlite to apply
the complete migration chain 001–012 and verify actual SQL writes, deduplication,
rollback, and an injected failure during the event INSERT. This runs without an
external database; it does not verify concurrency between server connections.
The separate `test:db` check verifies that on PostgreSQL using two connections.
The admin X Collector explorer automatically lists both graph tables after migration
012, with Russian labels and explanations of scores and priorities.

GitHub Actions `X Collector monitoring` provisions PostgreSQL 17, checks the build, applies the full migration chain twice, runs the two-connection integration test, and executes the one-cycle monitor on an empty database. It uses disposable test credentials and does not access production.

## Solana social agent foundation (migration 013)

Apply migrations before upgrading workers. Existing accounts default to `collector`.
Login with `npm run login -- reader1 collector` or `npm run login -- writer1 publisher`.
Use distinct actual X accounts, not two aliases for the same identity. The role
separates account selection; it does not detect two logins to the same X identity.
A name already registered for another role cannot be silently overwritten on login.
The collector claim query excludes publishers, and a database trigger prevents
social actions being assigned to collector accounts. X browser sessions remain
encrypted. A future live publisher needs its own official API credential adapter.

From the repository root:
```sh
npm run x-collector:agent -- status
npm run x-collector:agent -- start
npm run x-collector:agent -- discover
npm run x-collector:agent -- run
npm run x-collector:agent -- stop
```

The agent starts stopped. `start` enables discovery and **simulation only**, with
no per-action confirmation. The scheduler queues three bounded Solana/memecoin
searches hourly and runs a preview cycle every ten minutes. Search tasks go to the
existing worker and collector accounts. Pending searches and hourly idempotency
keys prevent backlog duplication. Collection still requires working collector
sessions and a running worker; no accounts need to be supplied as discovery seeds.

Candidates come from the last 24 hours of stored tweets, explicitly linked Solana
mint addresses or Solana/memecoin topic evidence. Keyword matching is a relevance
heuristic, not a token authenticity check. It ranks by author reputation and time,
then passes at most 100 candidates to a provider. The current `deterministic-preview`
adapter is **not AI**; the provider interface is ready for the later model choice.
Providers return a strictly validated list of action types, known source tweet IDs
and reasons. They cannot invoke tools, add target IDs or set limits. A 15-second
timeout aborts planning. Tweet text is untrusted input and is never executed.

Trusted post templates only link to source discussions. They do not repeat
unverified return claims. Reply generation and free-text model writing are not yet
connected. Post and repost choices are recorded as `simulated`; like, follow and
reply choices are `blocked`. Nothing in this module sends requests to X. Current X
rules prohibit automated likes/proactive following; AI replies require X permission
and recipient consent conditions. Policy source: https://help.x.com/en/rules-and-policies/x-automation

`social_agent_settings` stores the stop switch and limits (default 3 decisions per
cycle, 12 per UTC day across publishers). `social_agent_actions` stores the assigned
publisher, source evidence, provider and reason. All recorded decisions consume
the daily budget. Unique (kind,tweet_id) keys prevent duplicate actions across
accounts. Previously processed source tweets are excluded from later cycles.
All writes are transactional; invalid provider output leaves no partial actions.
The stop switch serializes with in-progress cycles, and takes effect once a running
planning transaction finishes (provider timeout is 15 seconds). Collector tasks
already queued are not cancelled by stop. These tables are available in the admin
X Collector explorer; `stopped=true` is the stop control.

Tests verify the actual collector claim SQL excludes publishers, the database role
trigger, source filtering, untrusted instructions, provider output validation,
discovery deduplication, default stop behavior and daily budgets. CI runs migrations
001–013 and agent CLI smoke checks on PostgreSQL 17. Live posting is deferred until
provider, official X API credentials and permitted action scope are configured.

## Admin agent tab (migration 014)

The dedicated **Агент Solana** tab shows preview status, daily budget, account roles,
settings, decisions and source links. It provides start/stop, typed limit editing,
account-role changes and queued run/discover buttons. Busy or stale accounts cannot
be reassigned; stale settings cannot overwrite newer changes. API access requires
admin authentication; session secrets are never returned. Mutation audit entries
are recorded after the collector transaction commits.

Apply migration 014 and run the upgraded scheduler before using immediate commands.
`social_agent_commands` stores pending/done/failed commands. The scheduler handles
one command at a time every ten seconds and atomically saves its result. Duplicate
pending commands are rejected. Stopping does not cancel existing collector tasks;
a queued preview command observes the stopped setting and performs no new actions.
If a command waits for more than a minute, verify that the scheduler is running.

The tab refreshes while commands wait, unless the user is editing settings. Source
text is escaped, never rendered as HTML. Mobile layout stays within the viewport;
horizontal scrolling is restricted to navigation. CLI and UI use the same settings
and preview pipeline. No live X transport or model has been connected.
