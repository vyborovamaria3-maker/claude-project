# Twitter/X analysis pipeline (no official API required)

The Trade Analysis social tab already has a real X collector. The new Twitter registry must reuse it rather than inventing a second scraper.

## Existing working path

```text
/trade/analysis/social
        |
        v
/api/trade/dev-twitter
        |
        v
lib/trade/twitter-scraper.ts
        |
        +--> Nitter search (fast, unauthenticated, metrics are limited)
        |
        `--> Playwright X search (authenticated browser session when available)
                |
                v
        parsed TweetData[]
                |
                +--> bot/shill/suspicion analysis
                +--> local twitter_token_tweets / twitter_accounts audit tables
                +--> TwitterStats.topTweets
                |
                v
        AnalysisSnapshot evidence
                |
                v
        /api/trade/social-ai -> Qwen
```

`strategy=auto` first tries Nitter. If Nitter returns no tweets and a saved browser session exists, it falls back to Playwright. No official X developer API key is required.

The search query is built from up to four signals:

```text
$SYMBOL OR SYMBOL OR MINT OR @official_handle
```

For official-account scope it uses:

```text
from:official_handle
```

## What Playwright parses

The current collector reads public tweet cards from X search and normalizes:

- tweet id
- text
- author handle
- display name when available
- timestamp
- likes
- reposts
- replies
- views when exposed by the UI
- verified marker
- canonical X status URL

The analysis route then computes suspicious/bot signals, per-author aggregates and top tweets. Those top tweets become X evidence inside the Social Intelligence snapshot that Qwen receives.

## Browser session

The repository already contains:

```bash
node scripts/x-login.mjs
```

It opens X in Playwright. Log in manually in that browser and press Enter in the terminal after login. The session is saved to:

```text
data/x-auth/storage-state.json
```

Treat this file as a secret. It contains active browser session cookies. Do not commit it.

The collector does not need a username/password in source code and does not need the official X API.

## Registry bridge

The FastAPI-side registry now reuses the exact output of `/api/trade/dev-twitter`.

Run the frontend first, then:

```bash
cd solana-launcher/backend
python -m app.cli.twitter_scrape_bridge \
  --mint <SOLANA_MINT> \
  --symbol <TICKER> \
  --strategy auto \
  --limit 60 \
  --hours 24 \
  --frontend-base http://localhost:3000
```

The bridge:

1. calls the existing Next.js collector;
2. receives the same `topTweets` and `shillers` used by Social Intelligence;
3. normalizes every author handle;
4. creates/reuses a `twitter_discovery_candidate`;
5. stores each tweet as a provenance/evidence record keyed by tweet id;
6. attaches mint, ticker, collector strategy, engagement and bot/suspicion context;
7. recalculates the candidate Discovery Score.

A handle is **not** converted into a fake numeric X user id. Until a trustworthy stable id is available, it remains a handle-based discovery candidate.

## Recommended local test

Terminal 1:

```bash
cd solana-launcher
npm run dev
```

If authenticated Playwright fallback is desired, create the session once:

```bash
node scripts/x-login.mjs
```

Terminal 2:

```bash
cd solana-launcher/backend
alembic upgrade head
python -m app.cli.twitter_scrape_bridge \
  --mint <SOLANA_MINT> \
  --symbol <TICKER> \
  --strategy auto \
  --limit 60 \
  --hours 24 \
  --frontend-base http://localhost:3000
```

Expected JSON output includes the actual collection strategy (`nitter` or `playwright`), number of parsed tweets and how many registry candidates were touched.

## Why this is the primary parser

This keeps one source of truth:

- Trade Analysis and Qwen see the same tweet parser output;
- the long-lived account registry receives the same observations;
- bot/shill logic stays consistent;
- no official X API dependency is introduced;
- if the collector implementation changes later, the registry bridge does not need to be redesigned.
