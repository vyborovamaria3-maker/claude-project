# X collector

This is the PostgreSQL X collector from fixed_project.zip, integrated as an isolated subsystem. It does not replace the existing SQLite collector inside solana-launcher.

## Migration chain and provenance

The repository contains the complete numbered 001–012 chain. `003_performance.sql` is an additive reconstruction, not the recovered original: it indexes `twitter_tweets.first_seen_at`, `tweet_token_links.linked_at`, terminal `x_tasks.created_at`, and terminal `scrape_runs.started_at`. These columns are defined by 001/002. Do not substitute the similarly named memecoin-intelligence migration. Apply the chain to a disposable dedicated PostgreSQL database before deployment; a file's presence does not prove it has been applied to your database. `npm run migrate -- --status` reports recorded migration state.

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

Tests cover shared helpers, browser navigation under CSP, partial API failures, encrypted sessions, and actual queue/account SQL against disposable PGlite. No external database or X credentials are required. The bundled test Chromium targets Linux; on other systems install a compatible Chromium and set TEST_CHROMIUM_PATH to its executable. PGlite tests do not replace multi-process integration checks on a dedicated PostgreSQL server.

Dashboard and metrics bind to loopback by default. External binds require Basic Auth and TLS at a reverse proxy. X login restrictions, captcha challenges and rate limits are surfaced as failures; the collector does not rotate identities to evade a platform restriction. Results are bounded by X search availability and configured limits, so the collector cannot guarantee every account or historical post.

Timeline refreshes store posts without linking every post to the mint that originally led to the account. Only search results explicitly queued for a mint create tweet-to-mint links.

The archive report is retained as FIX_REPORT_RU.md. It describes the supplied source snapshot and its verification limits.

See [DEVELOPMENT_REPORT_RU.md](DEVELOPMENT_REPORT_RU.md) for verified behavior and remaining integrations.

## AI Reply Guy

The integrated reply module is available at `/reply` in the dashboard or via `npm run reply:api`. See [REPLY_GUY_RU.md](REPLY_GUY_RU.md) for the plan mapping, official API credentials, Telegram, workers, deployment and verified limits. Migration 012 is additive and must be applied before enabling the module.
