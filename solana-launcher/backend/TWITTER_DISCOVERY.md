# Twitter/X Crypto Account Discovery

This crawler expands the Twitter intelligence registry from a small set of trusted seeds into a persistent discovery frontier.

## Sources

1. Curated seed handles in `data/twitter-discovery/crypto_media_seeds.json`.
2. Official X API recent-search authors and mentioned users using queries from `data/twitter-discovery/queries.json`.
3. Official X API following/follower graph expansion from accepted accounts.
4. Explicit `x.com/...` and `twitter.com/...` profile links found on operator-supplied public web/RSS pages.

The public-web source does not log in, bypass access controls, scrape private pages, or attempt anti-bot evasion.

## Identity and deduplication

A discovered handle starts as a `twitter_discovery_candidates` row. Once the official API resolves it, stable X `twitter_id` becomes the canonical identity. Username changes therefore do not create a new `twitter_accounts` identity.

Every discovery path is recorded in `twitter_discovery_evidence`, so later scoring can distinguish a curated seed, a search hit, a media-site link, a follower edge, and a following edge.

## Frontier safety

Candidates are claimed with a lease and `FOR UPDATE SKIP LOCKED` where the database supports it. Expired `processing` leases are claimable again. API failures use exponential retry/backoff, while permanent low-relevance/not-found candidates remain in the discovery registry rather than being deleted.

## Setup

Run the migrations and configure an official X API bearer token:

```bash
cd solana-launcher/backend
alembic upgrade head
export X_API_BEARER_TOKEN='...'
```

The crawler intentionally does not use `TWITTER_USERNAME`, `TWITTER_PASSWORD`, or `TWITTER_EMAIL` for automated login/scraping.

## Dry run

```bash
python -m app.cli.twitter_discovery --dry-run
```

## Recommended first pass

Use search + following expansion first. Following edges from known crypto/media accounts are usually much cleaner than indiscriminately ingesting their followers.

```bash
python -m app.cli.twitter_discovery \
  --network-mode following \
  --max-depth 2 \
  --network-limit 100 \
  --process-limit 500 \
  --min-relevance 35
```

## Wider coverage

Once the relevance filter is calibrated, add followers with bounded expansion:

```bash
python -m app.cli.twitter_discovery \
  --network-mode both \
  --max-depth 2 \
  --network-limit 250 \
  --process-limit 2000 \
  --min-relevance 35
```

## Add public media/research pages

```bash
python -m app.cli.twitter_discovery \
  --public-url https://example.com/crypto-team \
  --public-url https://example.com/feed.xml \
  --network-mode following
```

## Important operational rule

Do not try to fetch the entire follower graph in one run. The frontier is persistent by design: repeated bounded runs improve coverage while preserving provenance, rate-limit safety, and the ability to stop/restart the crawler.
