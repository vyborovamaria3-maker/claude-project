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

## Recommended no-X-API run

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

The output is a growing, ranked universe of crypto/memecoin/media X handles with provenance and discovery scores.

## Optional X API enrichment

If `X_API_BEARER_TOKEN` is configured later, `app.cli.twitter_discovery` can resolve stable IDs and expand following/follower graph edges. The public-source collector does not depend on it.
