#!/usr/bin/env bash
# A private localhost-only HTTP round-trip using exact pinned Codespaces weights.
set -Eeuo pipefail
if [[ "${CODESPACES:-}" != "true" ]]; then
  echo "Only run inside an existing GitHub Codespace" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
STATE="$ROOT/.local/sentiment"
P="$ROOT/.venv-sentiment/bin/python"
if [[ ! -x "$P" || ! -s "$STATE/model-revisions.env" || ! -s "$STATE/api-token" ]]; then
  echo "First run codespaces_setup.sh and codespaces_api.sh" >&2
  exit 2
fi
# shellcheck disable=SC1090
source "$STATE/model-revisions.env"
export SENTIMENT_REMOTE_ENABLED=true
export SENTIMENT_REMOTE_ENDPOINT=http://127.0.0.1:8765/v1/sentiment/predict
export SENTIMENT_REMOTE_TOKEN="$(cat "$STATE/api-token")"
export SENTIMENT_REMOTE_TIMEOUT_SECONDS=90
export SENTIMENT_BATCH_SIZE=2
# The *client* does not import torch; only the remote server performs inference.
echo "Testing opt-in HTTP client against Codespaces private pinned-model API..."
"$P" -m intelligence.nlp.cli --batch-size 2 --max-items 3 \
    --results-db "$STATE/remote-smoke-results.sqlite" \
    < "$STATE/smoke-input.jsonl" > "$STATE/remote-smoke-predictions.jsonl"
"$P" - "$STATE/remote-smoke-predictions.jsonl" <<'PY'
import json
import sys
from pathlib import Path
rows = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
expected = {"x:tweet:10001": {"cryptobert", "fintwitbert"},
            "tg:message:-100123:10": {"rubert"},
            "tg:message:-100123:11": {"cryptobert"}}
if len(rows) != 3 or {r["source_id"]: set(r["model_results"]) for r in rows} != expected:
    raise SystemExit("REMOTE CLIENT SMOKE FAILED: unexpected model routing")
print("REMOTE CLIENT SMOKE PASSED: three source items and exact model routing.")
print("Predictions saved in private ignored .local/sentiment/remote-smoke-results.sqlite.")
PY
