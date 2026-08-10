#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%s)-$$"
NET="potapoff-backtest-${STAMP}"
PG="potapoff-backtest-postgres-${STAMP}"
REDIS="potapoff-backtest-redis-${STAMP}"
TMP="$(mktemp -d -t potapoff-backtest.XXXXXX)"

cleanup() {
  set +e
  docker rm -f "$PG" "$REDIS" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

log() {
  printf '\n===== %s =====\n' "$*"
}

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $1" >&2
    exit 1
  }
}

need docker
need bash

docker info >/dev/null

echo "Repository: $ROOT"
echo "Backtest id: $STAMP"
echo "Production containers are not stopped or modified."

log "Production config / shell syntax"
for file in "$ROOT"/scripts/*.sh; do
  echo "bash -n ${file#$ROOT/}"
  bash -n "$file"
done

mkdir -p "$TMP/config/nginx" "$TMP/config/data"
cp "$ROOT/docker-compose.production.yml" "$TMP/config/docker-compose.production.yml"
cp "$ROOT/nginx/nginx.conf" "$TMP/config/nginx/nginx.conf"
: > "$TMP/config/backend.env"
: > "$TMP/config/.env.server"

(
  cd "$TMP/config"
  IMAGE_TAG=audit \
  POSTGRES_PASSWORD=test-postgres \
  RABBITMQ_PASSWORD=test-rabbit \
  SECRET_KEY=a9f4c2e8d7b1f6a3c9e5d2b8f7a4c1e9d6b3f8a2c5e7d4b9a1f3c6e8d2b7a5c9 \
  TELEGRAM_BOT_TOKEN=test-token \
  docker compose -f docker-compose.production.yml config >/dev/null
  IMAGE_TAG=audit \
  POSTGRES_PASSWORD=test-postgres \
  RABBITMQ_PASSWORD=test-rabbit \
  SECRET_KEY=a9f4c2e8d7b1f6a3c9e5d2b8f7a4c1e9d6b3f8a2c5e7d4b9a1f3c6e8d2b7a5c9 \
  TELEGRAM_BOT_TOKEN=test-token \
  docker compose -f docker-compose.production.yml config --services
)

docker run --rm \
  -v "$ROOT/nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:1.27-alpine nginx -t

log "Ephemeral PostgreSQL + Redis"
docker network create "$NET" >/dev/null

docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_DB=potapoff \
  -e POSTGRES_USER=potapoff \
  -e POSTGRES_PASSWORD=potapoff \
  postgres:16-alpine >/dev/null

docker run -d --name "$REDIS" --network "$NET" redis:7-alpine >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$PG" pg_isready -U potapoff -d potapoff >/dev/null 2>&1; then
    break
  fi
  sleep 1
docker inspect "$PG" >/dev/null 2>&1 || {
    echo "ERROR: PostgreSQL backtest container stopped unexpectedly" >&2
    exit 1
  }
done

docker exec "$PG" pg_isready -U potapoff -d potapoff >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$REDIS" redis-cli ping 2>/dev/null | grep -qx PONG; then
    break
  fi
  sleep 1
done

docker exec "$REDIS" redis-cli ping | grep -qx PONG

log "Backend: install / lint / typecheck / pytest / migrations / API smoke"
docker run --rm --network "$NET" \
  -v "$ROOT/backend:/src:ro" \
  -e SECRET_KEY=a9f4c2e8d7b1f6a3c9e5d2b8f7a4c1e9d6b3f8a2c5e7d4b9a1f3c6e8d2b7a5c9 \
  -e DATABASE_URL="postgresql+asyncpg://potapoff:potapoff@${PG}:5432/potapoff" \
  -e REDIS_URL="redis://${REDIS}:6379/0" \
  -e CELERY_RESULT_BACKEND="redis://${REDIS}:6379/1" \
  -e ENVIRONMENT=test \
  -e DEBUG=false \
  python:3.11-bookworm bash -lc '
    set -Eeuo pipefail
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends build-essential libpq-dev curl >/dev/null
    cp -a /src/. /work
    cd /work
    python -m pip install -q --upgrade pip
    python -m pip install -q -e ".[dev]" pip-audit

    echo "--- pip check"
    python -m pip check
    echo "--- compileall"
    python -m compileall -q app tests
    echo "--- ruff"
    ruff check app tests
    echo "--- mypy"
    mypy app
    echo "--- pytest"
    pytest -q
    echo "--- alembic heads"
    test "$(alembic heads | grep -c "(head)")" -eq 1
    alembic heads
    echo "--- migration up/down/up"
    alembic upgrade head
    alembic downgrade base
    alembic upgrade head

    echo "--- API smoke"
    python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 >/tmp/backtest-uvicorn.log 2>&1 &
    pid=$!
    trap "kill $pid 2>/dev/null || true" EXIT
    ok=0
    for _ in $(seq 1 60); do
      if curl -fsS http://127.0.0.1:8000/health >/dev/null; then
        ok=1
        break
      fi
      sleep 1
    done
    if [ "$ok" -ne 1 ]; then
      cat /tmp/backtest-uvicorn.log >&2 || true
      exit 1
    fi
    curl -fsS http://127.0.0.1:8000/health
    echo
    curl -fsS http://127.0.0.1:8000/ready
    echo
    curl -fsS http://127.0.0.1:8000/openapi.json -o /tmp/openapi.json
    python - <<"PY"
import json
with open("/tmp/openapi.json", "r", encoding="utf-8") as fh:
    data = json.load(fh)
paths = data.get("paths", {})
assert len(paths) >= 20, len(paths)
assert "/api/v1/social/token/{mint}" in paths
assert "/api/v1/telegram/token/{mint}" in paths
assert "/api/v1/subscriptions/orders" in paths
assert "/api/v1/auth/login-password" in paths
print("OPENAPI_PATHS", len(paths))
PY

    echo "--- pip-audit (informational; does not fail the backtest)"
    pip-audit || true
  '

log "Frontend: install / lint / typecheck / build / mobile + route smoke"
docker run --rm --ipc=host \
  -v "$ROOT:/src:ro" \
  -e NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000 \
  -e NEXT_PUBLIC_FRONTEND_URL=http://127.0.0.1:3000 \
  -e NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:8000 \
  -e NEXT_PUBLIC_BUILD_SHA=local-backtest \
  mcr.microsoft.com/playwright:v1.60.0-noble bash -lc '
    set -Eeuo pipefail
    cp -a /src/. /work
    cd /work
    npm ci --legacy-peer-deps

    echo "--- eslint (informational)"
    npm run lint || true
    echo "--- TypeScript"
    npx tsc --noEmit
    echo "--- Node script syntax"
    while IFS= read -r -d "" file; do
      echo "node --check $file"
      node --check "$file"
    done < <(find scripts tests -type f \( -name "*.js" -o -name "*.mjs" -o -name "*.cjs" \) -print0)
    echo "--- Next production build"
    npm run build

    echo "--- runtime smoke"
    npm start -- -p 3000 >/tmp/backtest-next.log 2>&1 &
    pid=$!
    trap "kill $pid 2>/dev/null || true" EXIT
    ok=0
    for _ in $(seq 1 60); do
      if curl -fsS http://127.0.0.1:3000/login >/dev/null; then
        ok=1
        break
      fi
      sleep 1
    done
    if [ "$ok" -ne 1 ]; then
      cat /tmp/backtest-next.log >&2 || true
      exit 1
    fi

    BASE_URL=http://127.0.0.1:3000 node tests/mobile-regression.mjs
    BASE_URL=http://127.0.0.1:3000 node tests/full-route-audit.mjs

    echo "--- npm audit (informational; does not fail the backtest)"
    npm audit --omit=dev --audit-level=high || true
  '

log "RESULT"
echo "FULL_LOCAL_BACKTEST=PASS"
echo "No production Docker service, production database, volume, or .env file was modified."
