# Twitter/X discovery without requiring the X API

The discovery pipeline is designed to work **without an official X API key**. `X_API_BEARER_TOKEN` is optional enrichment only.

## Primary no-X-API sources

The collector discovers public X/Twitter handles from crypto-native sources that already expose official social links:

1. **DEX Screener** public endpoints
   - latest token profiles
   - boosted tokens
   - token/pair metadata (`info.socials`)
2. **CoinMarketCap keyless public metadata** when available
   - official project `urls.twitter` links
3. Existing Solana token universe in the POTAPoff database
   - token mints are enriched through DEX Screener in batches
4. Public project websites / docs / RSS / media pages
   - only explicit `x.com/<handle>` / `twitter.com/<handle>` links are extracted
5. Telegram intelligence
   - public X links already observed in Telegram messages can be fed into the same frontier

No login-wall, CAPTCHA, anti-bot or private-page bypass is used.

## Identity model

Without the official X API, a stable numeric X user ID cannot always be resolved reliably. Therefore:

- `twitter_discovery_candidates` is the authoritative **handle universe / frontier**;
- candidates are deduplicated by normalized handle until a stable `twitter_id` becomes available;
- provenance is preserved in `twitter_discovery_evidence`;
- the stable `twitter_accounts` registry is promoted only when a trustworthy stable ID is available;
- scoring works for unresolved handle candidates too.

This avoids inventing synthetic X IDs that could later collide with real identities.

## Background collector and admin controls

Docker Compose runs `app.cli.twitter_discovery_daemon` as the dedicated `twitter-discovery` service. It runs the configured public-source collector every 15 minutes and the X/API discovery cycle every 30 minutes. The two collectors run sequentially inside one process, so scheduled Twitter discovery runs do not overlap each other.

The production Control Center at `admin.potapoff.fun` has a dedicated **X мониторинг** tab. It shows account/candidate/post growth, active and stale runs, queue status, recent accounts, run history, a read-only Twitter table explorer and the editable crawler settings. Settings writes use a strict field whitelist, validated ranges and optimistic locking on `updated_at` so two admin sessions cannot silently overwrite each other.

The backend SQLAdmin `/admin` also exposes **Twitter / X monitoring** tables as an internal/fallback view. The production Control Center is the primary operator UI.

Safe defaults enable DEX Screener latest profiles, latest boosts and enrichment of the latest 500 Solana tokens. CoinMarketCap discovery is disabled by default because its keyless public endpoint is less predictable; it can be enabled by setting a positive `public_cmc_limit` in admin.

Each individual run is written to `twitter_crawler_runs`, including phase heartbeats, final status, duration, summary and errors. Graceful cancellation is recorded as `cancelled`. A late heartbeat cannot revive a terminal run, and a `running` row with an expired heartbeat is treated as stale and is marked failed when the next run for that job starts.

The backend Docker image includes `data/twitter-discovery/crypto_media_seeds.json` and `data/twitter-discovery/queries.json`, which are used by the X/API cycle. Production health checks require the `twitter-discovery` container to be running.

## Manual no-X-API run

```bash
cd solana-launcher/backend
alembic upgrade head
python -m app.cli.twitter_discovery_public \
  --dexscreener-latest \
  --dexscreener-boosts \
  --db-solana-tokens 500 \
  --cmc-limit 500 \
  --rescore-limit 3000
```

Admin values are defaults. Explicit command-line flags take precedence for manual diagnostics. Boolean DEX Screener flags support both positive and negative forms, for example `--dexscreener-latest` and `--no-dexscreener-latest`.

The output is a growing, ranked universe of crypto/memecoin/media X handles with provenance and discovery scores.

## Optional X API enrichment

If `X_API_BEARER_TOKEN` is configured, `app.cli.twitter_discovery_cycle` can resolve stable IDs, search configured queries and expand following/follower graph edges. Without the token, public discovery still keeps the unresolved handle frontier growing and scored.
