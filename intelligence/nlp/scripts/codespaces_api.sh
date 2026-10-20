#!/usr/bin/env bash
# Explicit, authenticated localhost-only API for Codespaces port forwarding.
set -Eeuo pipefail
if [[ "${CODESPACES:-}" != "true" ]]; then
  echo "Only run inside GitHub Codespaces" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
STATE="$ROOT/.local/sentiment"
P="$ROOT/.venv-sentiment/bin/python"
if [[ ! -x "$P" || ! -s "$STATE/model-revisions.env" ]]; then
  echo "Run codespaces_setup.sh before starting the local API" >&2
  exit 2
fi
if [[ ! -s "$STATE/api-token" ]]; then
  "$P" - "$STATE/api-token" <<'PY'
import os
import secrets
import sys
from pathlib import Path
dest = Path(sys.argv[1])
temp = dest.with_suffix(".tmp")
temp.write_text(secrets.token_urlsafe(48), encoding="ascii")
os.chmod(temp, 0o600)
os.replace(temp, dest)
PY
fi
# shellcheck disable=SC1090
source "$STATE/model-revisions.env"
export SENTIMENT_API_TOKEN="$(cat "$STATE/api-token")"
export SENTIMENT_DEVICE=cpu
export SENTIMENT_MAX_LOADED_MODELS=1
export SENTIMENT_BATCH_SIZE=1
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export TOKENIZERS_PARALLELISM=false
export OMP_NUM_THREADS=2
export MKL_NUM_THREADS=2
export HF_HUB_DISABLE_TELEMETRY=1
echo "Starting auth-required localhost-only sentiment API on 127.0.0.1:8765."
echo "Keep the Codespaces forwarded port PRIVATE. Never publish the token."
exec "$P" -m intelligence.nlp.codespaces_api --host 127.0.0.1 --port 8765
