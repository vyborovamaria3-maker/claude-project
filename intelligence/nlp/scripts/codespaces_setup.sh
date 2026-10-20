#!/usr/bin/env bash
# One explicit, bounded model installation and real CPU smoke on a GitHub Codespace.
set -Eeuo pipefail
if [[ "${CODESPACES:-}" != "true" ]]; then
  echo "This setup is restricted to GitHub Codespaces; nothing installed." >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
export PIP_DISABLE_PIP_VERSION_CHECK=1
export TOKENIZERS_PARALLELISM=false
export OMP_NUM_THREADS=2
export MKL_NUM_THREADS=2
export OPENBLAS_NUM_THREADS=2
export HF_HUB_DISABLE_TELEMETRY=1
export SENTIMENT_DEVICE=cpu
export SENTIMENT_BATCH_SIZE=1
export SENTIMENT_MAX_LOADED_MODELS=1
export SENTIMENT_MAX_MEMORY_WAIT_SECONDS=30

# Avoid surprise disk exhaustion inside the Codespace quota.
python3 - <<'PY'
from pathlib import Path
from shutil import disk_usage
free = disk_usage(Path.cwd()).free
print(f"Available disk before setup: {free / 1024**3:.2f} GiB")
if free < 4 * 1024**3:
    raise SystemExit("At least 4 GiB of free disk is required for CPU torch and 3 weight files")
PY

PYTHON=""
for candidate in python3.12 python3.11 python3; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; assert (3, 11) <= sys.version_info[:2] <= (3, 12)' 2>/dev/null; then
    PYTHON="$candidate"
    break
  fi
done
if [[ -z "$PYTHON" ]]; then
  echo "Python 3.11 or 3.12 required in Codespaces" >&2
  exit 2
fi

VENV="$ROOT/.venv-sentiment"
STATE="$ROOT/.local/sentiment"
mkdir -p "$STATE"
chmod 700 "$STATE"
if [[ ! -x "$VENV/bin/python" ]]; then
  "$PYTHON" -m venv "$VENV"
fi
P="$VENV/bin/python"
# Debian/Ubuntu may create bin/python and then fail while bootstrapping pip
# if python3.12-venv was not installed yet. A later retry must *repair* this
# incomplete venv, not assume that the executable means installation worked.
if ! "$P" -m pip --version >/dev/null 2>&1; then
  echo "Detected an incomplete venv without pip; rebuilding it safely..."
  if ! "$PYTHON" -m venv --clear "$VENV"; then
    echo "Cannot create Python venv. On Ubuntu: sudo apt-get install python3.12-venv" >&2
    exit 2
  fi
fi
if ! "$P" -m pip --version >/dev/null 2>&1; then
  echo "Python venv is still missing pip after repair" >&2
  exit 2
fi
"$P" -m pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu 'torch>=2.4,<3'
"$P" -m pip install --no-cache-dir -r intelligence/requirements.txt -r intelligence/requirements-sentiment.txt
"$P" - <<'PY'
import torch
print("Torch:", torch.__version__, "CPU-only:", torch.version.cuda is None)
if torch.version.cuda is not None:
    raise SystemExit("GPU build detected; refusing non-CPU Codespaces installation")
PY

PINS="$STATE/model-revisions.env"
if [[ ! -s "$PINS" ]]; then
  INFO="$(mktemp "$STATE/.prefetch.XXXXXX")"
  trap 'rm -f "$INFO"' EXIT
  echo "Fetching approved Safetensors only; expected ~1.1 GB of weights..."
  "$P" -m intelligence.nlp.prefetch --models cryptobert fintwitbert rubert --download | tee "$INFO"
  "$P" - "$INFO" "$PINS" <<'PY'
import os
import re
import sys
from pathlib import Path
lines = Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
expected = {"SENTIMENT_CRYPTOBERT_REVISION", "SENTIMENT_FINTWITBERT_REVISION",
            "SENTIMENT_RUBERT_REVISION"}
revisions = {}
for line in lines:
    match = re.fullmatch(r"(SENTIMENT_(?:CRYPTOBERT|FINTWITBERT|RUBERT)_REVISION)=([0-9a-f]{40})", line)
    if match:
        revisions[match.group(1)] = match.group(2)
if set(revisions) != expected:
    raise SystemExit("Unable to persist all three verified immutable model revisions")
dest = Path(sys.argv[2])
temp = dest.with_suffix(".tmp")
temp.write_text("".join(f"export {key}={revisions[key]}\n" for key in sorted(expected)), encoding="utf-8")
os.chmod(temp, 0o600)
os.replace(temp, dest)
PY
else
  echo "Using existing immutable model pins; refusing silent upgrade."
fi
# Shell source is safe because this file was generated from a strict SHA-only format.
set -a
# shellcheck disable=SC1090
source "$PINS"
set +a
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
"$P" -m intelligence.nlp.cli --check-config --batch-size 1 --max-items 3

# Only public synthetic examples, no real Telegram or X credentials/contents.
"$P" - "$STATE" <<'PY'
import json
import sys
from pathlib import Path
root = Path(sys.argv[1])
items = [
    {"source":"x","source_id":"x:tweet:10001",
     "text":"Crypto market is bullish on Bitcoin today!",
     "observed_at":"2026-10-19T00:00:00Z"},
    {"source":"tg","source_id":"tg:message:-100123:10",
     "text":"Это действительно хорошие новости для рынка!",
     "observed_at":"2026-10-19T00:00:00Z"},
    {"source":"tg","source_id":"tg:message:-100123:11",
     "text":"Bitcoin sentiment is strongly bearish today!",
     "observed_at":"2026-10-19T00:00:00Z"},
]
(root / "smoke-input.jsonl").write_text(
    "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in items), encoding="utf-8")
(root / "api-request.json").write_text(
    json.dumps({"items": items}, ensure_ascii=False), encoding="utf-8")
PY
echo "Running three REAL CPU forward passes with cached model weights..."
"$P" -m intelligence.nlp.cli --batch-size 1 --max-items 3 \
    --results-db "$STATE/smoke-results.sqlite" \
    < "$STATE/smoke-input.jsonl" > "$STATE/smoke-predictions.jsonl"
"$P" - "$STATE/smoke-predictions.jsonl" <<'PY'
import json
import sys
from pathlib import Path
data = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
expected = {"x:tweet:10001":{"cryptobert","fintwitbert"},
            "tg:message:-100123:10":{"rubert"},
            "tg:message:-100123:11":{"cryptobert"}}
if len(data) != 3 or {r["source_id"]:set(r["model_results"]) for r in data} != expected:
    raise SystemExit("Real-model smoke FAILED: unsupported routing or missing model logits")
for row in data:
    print(row["source_id"] + " : " + ", ".join(sorted(row["model_results"])) + " OK")
print("ALL THREE exact-revision models passed real forward inference on CPU.")
PY
echo "Ready. No collector data accessed; no API port opened."
echo "Optional local API: bash intelligence/nlp/scripts/codespaces_api.sh"
