# Rights-gated historical dataset staging and normalized research projections

No data downloads, network access, automatic license approval, mint verification,
production delivery or AI training. All candidates start rights=review_required.

## Source registry

- Coin-Meme: real published metadata columns are token_name, token_ticker,
  token_address, description, mCap, createdAt, bonding_completeTime.
  The actual createdAt sample is DD/MM/YYYY, HH:mm:ss, with no timezone.
- MemeChain: source join key (address, platform); social_info.csv supplies
  website, twitter, telegram and discord endpoints. Multi-chain records are
  filtered to Solana only, and all links are treated as unverified assertions.
- MELT, Trenches and Reddit use Parquet and remain unimplemented in this slice.

Repository code license does not automatically license third-party user comments.
Conduct a separate review of original data conditions, privacy, erasure and
intended use. Keep the operator authorization JSON OUTSIDE this repository:

~~~json
{
  "coin-meme": {
    "status": "approved",
    "allowed_uses": ["research"],
    "reviewed_by": "operator",
    "evidence_reference": "actual-rights-review-reference"
  }
}
~~~

This file records the operator's review; it does not itself create permission.

## Offline usage

~~~sh
python3 dataset-ingestion/ingest.py catalog
python3 dataset-ingestion/ingest.py inspect --input /private/destription+finance.csv
python3 dataset-ingestion/ingest.py import --source coin-meme \
  --input /private/destription+finance.csv \
  --authorization /private/rights.json \
  --db /private/datasets.sqlite --purpose research
python3 dataset-ingestion/normalize.py --source coin-meme --db /private/datasets.sqlite
python3 dataset-ingestion/normalize.py --source memechain --db /private/datasets.sqlite
python3 -m unittest discover -s dataset-ingestion/tests -v
~~~

Supported raw staging: CSV, JSONL and ZIP containing these. Explicitly rejects
unsupported Parquet until bounded streaming adapters are reviewed.

Staging records file digest and sizes, raw payload digest, import run status,
timestamp precision, observed/ingested/available time and rights reference.
Reimporting the same file preserves its original per-row availability.
A source event from 2024 first imported in 2026 is NOT treated as available in 2024.

## Research-only source projections

normalize.py refuses arbitrary dataset IDs, creates source-specific tables and
never writes to the central Intelligence database:

1. token_metadata_projections: Coin-Meme mint CANDIDATE, name, ticker, description,
   original createdAt string with unknown timezone, real first availability.
2. token_outcomes_research_only: mCap and bonding_completeTime, both NOT safe
   launch-time features because measurement availability is not proven.
3. token_social_link_projections: Solana-only MemeChain source-asserted URLs,
   no automatic crawling; mint candidate NOT chain-verified.

Coin-Meme comments.csv.zip header layout is not yet verified. Comment rows without
verified token_address join fields are deliberately not projected.

Every candidate must be independently linked to an actual SPL mint through
trusted Solana evidence. Base58 32-byte decoding only proves syntactic plausibility.
Do not join candidates by ticker/name or expose raw descriptions, author data or
URLs as verified evidence.

## Production blockers

Retention and erasure across raw files, SQLite, normalized tables, backups, and
derived indices are not yet implemented. Do not serve this staging database as
production content. Dataset-specific file manifests and schema changes must be
reviewed before large imports. Research replay must be separate from actual
knownAt and must disclose missing historical coverage and selection bias.
