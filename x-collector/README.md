# X collector

This is the PostgreSQL X collector from fixed_project.zip, integrated as an isolated subsystem. It does not replace the existing SQLite collector inside solana-launcher.

## Migration chain is incomplete

The supplied archive is missing migrations/003_performance.sql. The migration command checks for the complete 001–011 chain before opening a database connection and stops without changing the database while 003 is missing. Do not substitute memecoin-intelligence/db/migrations/003_performance.sql: it belongs to a different schema. Restore the exact collector migration from its original source before migrating.

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

The mint file accepts one Solana address per line; blank lines and lines starting with # are ignored. The importer validates and deduplicates addresses, then queues one X search per mint. Start scheduler, dashboard and outbox publisher in separate terminals with x-collector:scheduler, x-collector:dashboard and x-collector:publisher.

Dashboard and metrics bind to loopback by default. External binds require Basic Auth and TLS at a reverse proxy. X login restrictions, captcha challenges and rate limits are surfaced as failures; the collector does not rotate identities to evade a platform restriction. Results are bounded by X search availability and configured limits, so the collector cannot guarantee every account or historical post.

Timeline refreshes store posts without linking every post to the mint that originally led to the account. Only search results explicitly queued for a mint create tweet-to-mint links.

The archive report is retained as FIX_REPORT_RU.md. It describes the supplied source snapshot and its verification limits.
