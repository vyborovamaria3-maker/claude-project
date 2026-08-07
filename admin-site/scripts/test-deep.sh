#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

python -m unittest discover -s admin-site/tests -v
python -m compileall -q admin-site

python - <<'PY'
import json
from pathlib import Path

for path in Path("admin-site").rglob("*.json"):
    json.loads(path.read_text(encoding="utf-8-sig"))
    print(f"JSON_OK {path}")
PY

if command -v node >/dev/null 2>&1; then
  while IFS= read -r -d '' file; do
    node --check "$file" >/dev/null
  done < <(find admin-site -type f -name '*.js' -print0)
fi

printf 'Admin Control Center deep checks completed successfully.\n'
