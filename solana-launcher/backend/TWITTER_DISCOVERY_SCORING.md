# Twitter/X Discovery Scoring

The discovery crawler uses a persistent score to decide which crypto/media accounts should be processed first.

## Formula

`discovery_score` is normalized to 0..100 and currently uses `discovery-score-v1`:

- relevance: 28%
- source/evidence quality: 16%
- graph quality: 18%
- engagement/profile quality: 12%
- early-signal history: 18%
- recency: 8%

The complete component breakdown and confidence are stored in `twitter_discovery_scores`.

### Relevance

Uses the candidate relevance hint, resolved profile relevance, Solana relevance and existing account relevance scores when available.

### Source/evidence quality

Rewards stronger sources and independent confirmation. Curated seeds, X search, strong following edges, public-web links and follower edges receive different weights. Multiple source types raise the score more than repeated evidence from one source.

### Graph quality

Rewards candidates connected to already-scored accounts with strong trust, alpha and influence. Once a candidate has its own account score, its trust/influence can also contribute.

### Engagement/profile quality

Before posts are stored, profile scale, follower/following ratio, activity and verification provide a bounded fallback signal. Once posts exist, observed interactions and views are used as the stronger signal.

### Early-signal history

For promoted accounts this combines the existing account `alpha_score`, per-token `token_alpha_score` history and successful/failed call ratio. This prevents raw follower count from dominating discovery priority.

### Recency

Recent discoveries receive more weight. The current v1 decay has a 30-day exponential time scale.

## Priority behavior

For resolved candidates, frontier `priority` becomes the rounded discovery score. For unresolved candidates, the crawler preserves a higher seed/search priority until profile resolution so important initial seeds are not pushed down before they can be checked.

## Commands

Apply migrations:

```bash
cd solana-launcher/backend
alembic upgrade head
```

Rescore the current database without crawling:

```bash
python -m app.cli.twitter_discovery_rescore --limit 2000 --show-top 30
```

Preview without committing:

```bash
python -m app.cli.twitter_discovery_rescore --limit 500 --dry-run
```

Run a self-prioritizing discovery cycle:

```bash
python -m app.cli.twitter_discovery_cycle \
  --network-mode following \
  --max-depth 2 \
  --network-limit 100 \
  --process-limit 500 \
  --rescore-limit 1500 \
  --min-relevance 35
```

A cycle performs:

1. seed/public-web/X-search ingestion;
2. frontier rescore;
3. priority-ordered frontier crawling;
4. a second rescore so newly discovered network accounts are prioritized for the next cycle.

For larger databases, run bounded cycles repeatedly instead of one unbounded crawl. This keeps X API rate limits, retries and database load predictable.

## Interpretation

`discovery_score` answers: **how valuable is it to spend collection budget on this account next?**

It is not the same as `alpha_score` or `trust_score`. A newly discovered account may have high discovery value with low confidence. Confidence rises as independent evidence, resolved profile data, graph context and token history accumulate.
