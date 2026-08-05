#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/potapoff-deploy}"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.production.yml"
IMAGE_TAG="${IMAGE_TAG:-$(cat "$DEPLOY_DIR/.current-image-tag")}"
export IMAGE_TAG

cd "$DEPLOY_DIR"

for attempt in $(seq 1 45); do
  if curl -fsS http://127.0.0.1/ >/dev/null \
    && curl -fsS http://127.0.0.1/miniapp >/dev/null \
    && curl -fsS http://127.0.0.1/fastapi/health >/dev/null; then

    unhealthy="$(
      docker compose --env-file .env.server -f "$COMPOSE_FILE" ps \
        --format json 2>/dev/null |
      python3 -c '
import json, sys
raw=sys.stdin.read().strip()
if not raw:
    print("missing")
    raise SystemExit
items=[]
try:
    parsed=json.loads(raw)
    items=parsed if isinstance(parsed,list) else [parsed]
except json.JSONDecodeError:
    items=[json.loads(line) for line in raw.splitlines() if line.strip()]
bad=[]
for item in items:
    state=str(item.get("State","")).lower()
    health=str(item.get("Health","")).lower()
    if state != "running" or health == "unhealthy":
        bad.append(item.get("Service") or item.get("Name") or "unknown")
print(",".join(bad))
'
    )"

    if [[ -z "$unhealthy" ]]; then
      echo "HEALTHCHECK_OK"
      exit 0
    fi
  fi
  sleep 4
done

docker compose --env-file .env.server -f "$COMPOSE_FILE" ps
docker compose --env-file .env.server -f "$COMPOSE_FILE" logs --tail 120 frontend backend nginx
exit 1
