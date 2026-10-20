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
  observed/occurred timestamps (UTC), model repository, exact immutable HF
  commit SHA, tokenizer-length contract, separate 3-way probability maps.
- Results are stored under `IntelligenceDocument.metrics["sentiment-v1"]`.
  The original content and `raw_hash` evidence remain unchanged. Existing
  JSON-based SQLite/PG stores already persist metrics. Repeat runs with
  different revisions require an explicit reprocessing strategy.
- Every input uses **observation time**. Do not backdate a new model
  prediction as if the model was available when the original event occurred.
  Add `inference_at` and model-availability tracking before use in
  historical trading backtests.
- This is classification of the full *message*, not per-token sentiment:
  linking predictions to specific Solana token mints requires an independent
  exact-evidence resolver.

## Local installation (only on your own machine)

Use Python 3.12 and an isolated virtual environment; do not install ML
packages into the normal collectors or the production Intelligence Docker
image. Model downloads can be hundreds of MB; check disk space and licenses.

```bash
python -m pip install -r intelligence/requirements-sentiment.txt
```

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
