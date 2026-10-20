# Local X/TG sentiment inference — optional NLP module

Three explicitly selected **Hugging Face sequence classifiers**, with no
weights bundled or automatically downloaded by collectors:

| Routed input | Model | Scope | Original output labels |
| --- | --- | --- | --- |
| EN X and EN TG | `ElKulako/cryptobert` | Crypto-asset **stance** | bearish, neutral, bullish |
| EN X (independent classifier) | `StephanAkkerman/FinTwitBERT-sentiment` | Financial **stance** | neutral, bullish, bearish |
| RU TG | `seara/rubert-tiny2-russian-sentiment` | General emotion/sentiment | neutral, positive, negative |

**Do not average CryptoBERT/FinTwitBERT with RuBERT** or call generic
Russian "positive" a bullish price prediction. Neither model proves
manipulation, token ownership, future returns or profitable trades. Language
detection is deliberately conservative; ambiguous or mixed-language
messages return `unsupported_language` rather than guessed class labels.

## Default-safe integration

- Existing collectors, Intelligence worker and database behavior are **unchanged
  by default**. Setting `INTELLIGENCE_SENTIMENT_ENABLED=true` enables the
  optional enrichment hook inside the **existing Python IntelligenceWorker**.
  The hook only runs on normalized documents with `source=x|twitter|tg|telegram`
  and a stable `id=x:tweet:<id>` or `id=tg:message:<peer>:<message>`.
- The current source Outbox path may include **metadata-only payloads** to
  avoid exporting private message bodies. This module **cannot classify
  unavailable text**: do not invent it from the metadata. Connect an
  explicitly authorized, secure text-access adapter in a separate PR.
- No model is loaded unless sentiment is enabled AND an eligible source
  document is processed. Models are loaded once per process, on demand,
  from a *pre-downloaded local Hugging Face cache* only. No runtime network
  access to HF, no remote trust code or pickle weights.
- Source message content is never copied into the sentiment result. Output
  includes canonical source message ID, SHA-256 of exact input text,
  observed/occurred timestamps (UTC) **and actual inference_at** (never\n  backdated), model repository, exact immutable HF
  commit SHA, tokenizer-length contract, separate 3-way probability maps.
- Results are stored under `IntelligenceDocument.metrics["sentiment-v1"]`.
  The original content and `raw_hash` evidence remain unchanged. Existing
  JSON-based SQLite/PG stores already persist metrics. Repeat runs with
  different revisions require an explicit reprocessing strategy.
- Every input uses **observation time** and stores independent **inference_at**.
  Do not backdate a new model prediction as if the model was available when
  the original event occurred. Proper feature publication/availability gating
  is still required for historical trading backtests.
- This is classification of the full *message*, not per-token sentiment:
  linking predictions to specific Solana token mints requires an independent
  exact-evidence resolver.

## Local installation (only on your own machine)

Use Python 3.12 and an isolated virtual environment; do not install ML
packages into the normal collectors or the production Intelligence Docker
image. Model downloads can be hundreds of MB; check disk space and licenses.

```bash
python -m pip install -r intelligence/requirements.txt -r intelligence/requirements-sentiment.txt
```

Explicit command for public model revision lookup, and optional local download:

```bash
python -m intelligence.nlp.prefetch --models cryptobert fintwitbert rubert
python -m intelligence.nlp.prefetch --models cryptobert fintwitbert rubert --download
```

The first command queries only repository metadata; the second downloads
approved tokenizer/config/safetensors files into the operator's local cache
and prints the exact model commit SHA environment variables. On Windows
PowerShell, set each printed value using `$env:VARIABLE="sha"`.

Retrieve *real* upstream immutable 40-character commit revisions for **all**
three repositories before running. Example explicit preparation script:

```python
from huggingface_hub import HfApi, snapshot_download
repositories = {
    "SENTIMENT_CRYPTOBERT_REVISION": "ElKulako/cryptobert",
    "SENTIMENT_FINTWITBERT_REVISION": "StephanAkkerman/FinTwitBERT-sentiment",
    "SENTIMENT_RUBERT_REVISION": "seara/rubert-tiny2-russian-sentiment",
}
for variable, repo in repositories.items():
    revision = HfApi().model_info(repo).sha
    print(variable, revision)
    snapshot_download(repo_id=repo, revision=revision, allow_patterns=[
        "*.json", "*.txt", "*.model", "vocab.*", "merges.txt",
        "tokenizer.*", "*.safetensors",
    ])
```

Pin the printed SHA values in local environment settings as
`SENTIMENT_CRYPTOBERT_REVISION`, `SENTIMENT_FINTWITBERT_REVISION`,
`SENTIMENT_RUBERT_REVISION`. Never store credentials, environment secrets
or downloaded model weights in the repository. Once cached, runtime loading
is offline-only. Default device is CPU; use `SENTIMENT_DEVICE=cuda:0`
with installed CUDA-enabled PyTorch to use your local NVIDIA GPU.

### Local JSONL batch without touching databases

Each **input line** must contain exact source ID and observed timestamp:

```json
{"source":"x","source_id":"x:tweet:123","text":"This crypto looks bullish today","observed_at":"2026-10-20T08:00:00Z"}
{"source":"tg","source_id":"tg:message:-100123:456","text":"Рынок сегодня выглядит очень сильным","observed_at":"2026-10-20T08:00:00Z"}
```

```bash
python -m intelligence.nlp.cli --check-config
python -m intelligence.nlp.cli --batch-size 8 --max-items 100 < messages.jsonl > predictions.jsonl
```

JSONL output contains **no raw message text**. It contains per-model label
probabilities and evidence/time metadata only; protect it accordingly.
Invalid records or missing cached weights fail closed with a redacted error.
Run on laptop; no cloud server is required for X Collector.

### Enable for normalized Intelligence provider documents

Set `INTELLIGENCE_SENTIMENT_ENABLED=true` (explicit opt-in) and all revision
variables, then launch the existing Python worker. The hook writes enriched
`IntelligenceDocument.metrics` using existing store APIs. It does not start
a new database, scrape accounts, query providers or migrate tables.

### Checks without weights/GPU

```bash
python -m unittest intelligence.tests.test_sentiment -v
python -m unittest intelligence.tests.test_worker_pipeline -v
```

The lightweight CI tests use an injected deterministic fake backend. This
validates routing, batching, provenance, no-text output, opt-in persistence,
probabilities and fail-closed rules — **not** quality of the real weights.
After downloading the three real models, run an actual small local smoke
test and a human-labelled EN/RU crypto/X/TG benchmark before deploying.

## Read directly from local existing X/TG PostgreSQL (opt-in)

The `--collector-db` mode avoids manual JSONL export by reading the latest
**already persisted** collector text. It does not open an X browser, join a
Telegram channel, or issue provider requests. It uses a PostgreSQL
`SET TRANSACTION READ ONLY` transaction and an explicitly bounded LIMIT,
and does not modify the source database.

```bash
# Use an account GRANTed SELECT only on the specific necessary source tables:
#   X: twitter_tweets
#   TG: tg_messages, tg_sources
# Set X_SOURCE_DATABASE_URL or TG_SOURCE_DATABASE_URL in a local secret store.
SENTIMENT_SOURCE_READ_ENABLED=true python -m intelligence.nlp.cli --collector-db x --max-items 50 > x-sentiment.jsonl
SENTIMENT_SOURCE_READ_ENABLED=true python -m intelligence.nlp.cli --collector-db tg --max-items 50 > tg-sentiment.jsonl
```

All three model revisions must first be pinned, and their weights downloaded
to the laptop cache. Do not pass DSNs as CLI arguments or log them.
This mode processes a bounded **current latest snapshot** of eligible messages.
It is not a historical replay or complete source archive. TG uses the stable
`tg_sources.peer_id + message_id` and excludes deleted messages;
X uses stable `twitter_tweets.tweet_id`, not mutable handles. Neither source
query automatically establishes a Solana mint or predicts a trade outcome.

Outputs contain per-model metadata/probabilities, source IDs, times and the
source message SHA-256, **not** original message text. Storing these derived
records into a production Intelligence feature table is a separate, reviewed
migration/ETL step; no new model data is silently written to user databases.

## Optional durable local result store (new standalone SQLite file)

The standalone `--results-db` mode is **opt-in**. It writes ONLY derived
model probabilities and provenance to a **separate absolute SQLite file**,
never to X/TG source databases or the existing Intelligence runtime DB.

```powershell
# Windows PowerShell, from repository root with Python venv and cached models:
$env:SENTIMENT_SOURCE_READ_ENABLED="true"
py -m intelligence.nlp.cli --collector-db x --max-items 50 --results-db "C:\\sentiment-data\\model-results.sqlite"
py -m intelligence.nlp.cli --collector-db tg --max-items 50 --results-db "C:\\sentiment-data\\model-results.sqlite"
```

Source DSNs must be provided through local environment variables and a
database login restricted to SELECT. The sink rejects existing collector
tables. It stores separate immutable result rows per source message, exact
content hash, preprocessor version, model name and immutable model revision.
Duplicate replays are no-ops, changing a model's revision produces distinct
rows, and failure rolls back the entire batch. Inference time is recorded
independently of source event time. Raw message text and provider sessions
are **not** persisted to this database.

Run these commands only after backing up/verifying the local databases and
performing a small real-weight inference smoke. SQLite prediction rows are
derived analytics, not authoritative trades or automatically validated
sentiment for any specific Solana mint. The command is finite and does not
run as a background service.
