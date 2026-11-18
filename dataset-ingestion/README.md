# Permission-gated historical dataset staging (first vertical slice)

This is a local research importer, not a collector or a producer into Node Intelligence.
It does not download data, connect to accounts, or perform SPL mint verification.

The JSON catalog lists candidate datasets; ALL start with rights=review_required.
Repository code license does not automatically license user comments or third-party content.
Obtain a legitimate right to your proposed use, check data terms and privacy,
then create a private operator-reviewed authorization JSON outside the repository:

~~~json
{
  "coin-meme": {
    "status": "approved",
    "allowed_uses": ["research"],
    "reviewed_by": "operator",
    "evidence_reference": "internal-permission-record"
  }
}
~~~

The approval record is an audit control, not independent proof of legal permission.

~~~sh
python3 dataset-ingestion/ingest.py catalog
python3 dataset-ingestion/ingest.py inspect --input /private/comments.csv.zip
python3 dataset-ingestion/ingest.py import --source coin-meme \
  --input /private/comments.csv.zip --db /private/staging.sqlite \
  --authorization /private/rights.json --purpose research --limit 1000
python3 -m unittest discover -s dataset-ingestion/tests -v
~~~

Supported now: CSV, JSONL and ZIP containing CSV/JSONL. Parquet-based MELT/Trenches
and Reddit are registered but fail closed until a streaming schema-aware adapter exists.

The staging SQLite database may contain raw user-generated text; store privately and
enforce source-specific retention and deletion requirements before any live deployment.
No data is promoted to central Intelligence; no regex-based address is verified.
A source event from 2024 first imported in 2026 has available_at=2026, not 2024.
Day-only timestamps remain day precision, and timezone-naive dates are rejected.
Duplicate imports of the same source file preserve the original available_at.

Next phases: rights/retention enforcement, schema-specific validators, Parquet streaming,
verified mint evidence, explicit research replay, Discord permissions, transactional outbox,
contract V2 and central source coverage / scoring. See architecture roadmap.
