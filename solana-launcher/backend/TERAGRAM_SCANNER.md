# TeraGram scanner

TeraGram is the primary large historical Telegram dataset for POTAPoff discovery work.
The legacy TGDataset Zenodo record `7640712` remains supported by `tgdataset_filter.py` so old
checkpoints and tests do not break, but new large-scale filtering should use `teragram_filter.py`.

## Source identity

- Pinned preview supplied for analysis: Zenodo record `18262126`, preview version `0.1.0`.
- That record is explicitly marked as an old preview version by Zenodo.
- Latest-preview concept DOI: `10.5281/zenodo.18262125`.
- Full TeraGram dataset DOI: `10.25625/GDCXQK`.
- Upstream schema/code: `https://github.com/Priesemann-Group/telegram_quality_control`.

Do not replace the legacy `ZENODO_RECORD_ID = 7640712` constant with `18262126`: the two datasets
have different schemas. The old TGDataset is tar.gz + channel JSON; TeraGram is relational CSV/Parquet.

## Supported layout

The scanner discovers either preview CSV files or the full Parquet layout. Examples:

```text
/data/teragram/
  chats.csv
  messages.csv
  entity_urls.csv
  entity_hashtags.csv
```

or:

```text
/data/teragram/
  chats.parquet
  messages/
    messages_batch_00.parquet
    messages_batch_01.parquet
  entity_urls/
    entity_urls_batch_00.parquet
  entity_hashtags/
    entity_hashtags_batch_00.parquet
```

If controlled-access message text is present, also place `message_content.csv`,
`message_content.parquet`, or `message_content/*.parquet` in the same root.

## Why DuckDB

The full TeraGram dataset is multi-terabyte and contains billions of rows. The scanner therefore does
not load tables into Python lists or dictionaries. DuckDB scans only the required Parquet/CSV columns,
spills to disk when needed, builds the candidate set out of core, and sends only cheap-pre-gated signal
rows into Python.

The Python stage reuses `TGDatasetChannelAccumulator`, so exact Solana address validation and the
existing crypto / memecoin / Solana / caller scoring stay in one implementation.

`--signal-source auto` uses:

1. `message_content` when text/captions are available;
2. otherwise per-message URL + hashtag entities;
3. otherwise metadata only.

The normal public TeraGram release does not include message text, so entity mode is expected for that
release. Metadata-only matches are intentionally not promoted to seeds unless they satisfy the existing
scoring rules; the scanner does not invent missing message evidence.

## Install

From `solana-launcher/backend`:

```bash
pip install -e ".[teragram]"
```

Development/test environment:

```bash
pip install -e ".[dev]"
```

## Run a smoke scan

```bash
python -m app.cli.teragram_filter \
  --input-dir /data/teragram \
  --output data/teragram \
  --max-chats 1000 \
  --memory-limit 4GB
```

Full local scan example:

```bash
python -m app.cli.teragram_filter \
  --input-dir /data/teragram \
  --output data/teragram \
  --memory-limit 16GB \
  --threads 8 \
  --seed-limit 1000
```

Use a fast SSD/NVMe path for `--temp-dir` on large scans. `--memory-limit` is a hard DuckDB ceiling;
large intermediate joins can spill to the temp directory instead of exhausting RAM.

## Outputs

- `teragram_candidates.jsonl` — all channels that pass the existing scoring thresholds.
- `crypto_channels.json`
- `memecoin_channels.json`
- `solana_channels.json`
- `caller_channels.json`
- `telegram_seed_database.json` — small top-N file already compatible with live public discovery.
- `summary.json`
- `teragram_manifest.json`
- `teragram.duckdb` — local disk-backed scan state/query database.

The generated seed database is historical. Live Telegram discovery must still revalidate that a channel
exists and is currently relevant before using it in analysis.
