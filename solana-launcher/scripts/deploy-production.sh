#!/usr/bin/env bash
set -Eeuo pipefail

NEW_TAG="${1:?Usage: deploy-production.sh <image-tag>}"

DEPLOY_DIR="${DEPLOY_DIR:-/opt/potapoff-deploy}"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.production.yml"
BACKUP_SCRIPT="$DEPLOY_DIR/scripts/backup-production.sh"
HEALTH_SCRIPT="$DEPLOY_DIR/scripts/healthcheck-production.sh"
PROMETHEUS_CONFIG="$DEPLOY_DIR/prometheus/prometheus.yml"
ADMIN_DIR="${ADMIN_DIR:-/opt/claude-project/admin-site}"
ADMIN_COMPOSE_FILE="$ADMIN_DIR/docker-compose.yml"

cd "$DEPLOY_DIR"

test -r .env.server
test -r backend.env
test -r "$COMPOSE_FILE"
test -r "$BACKUP_SCRIPT"
test -r "$HEALTH_SCRIPT"
test -r "$PROMETHEUS_CONFIG"
test -r "$ADMIN_COMPOSE_FILE"

env_value_from_file() {
  local file="$1"
  local key="$2"
  local value
  value="$(sed -n "s/^${key}=//p" "$file" | tail -n 1)"
  printf '%s' "${value%$'\r'}"
}

resolved_backend_env_value() {
  local key="$1"
  local value
  value="$(env_value_from_file .env.server "$key")"
  if [[ -z "$value" ]]; then
    value="$(env_value_from_file backend.env "$key")"
  fi
  printf '%s' "$value"
}

# The frontend's Mini App routes make authenticated server-to-server requests
# to the FastAPI subscription endpoints. Keep backend.env private, but export
# only the shared API key so Docker Compose can inject it into the frontend.
if [[ -z "${BACKEND_API_KEY:-}" ]]; then
  BACKEND_API_KEY="$(env_value_from_file .env.server BACKEND_API_KEY)"
fi
if [[ -z "${BACKEND_API_KEY:-}" ]]; then
  BACKEND_API_KEY="$(env_value_from_file backend.env BACKEND_API_KEY)"
fi
if [[ -z "${BACKEND_API_KEY:-}" ]]; then
  echo "BACKEND_API_KEY is required in .env.server or backend.env" >&2
  exit 1
fi
export BACKEND_API_KEY

# The admin stack owns the same external network so the public ingress can
# route admin.potapoff.fun directly to potapoff-admin:8080.
docker network inspect potapoff-shared >/dev/null 2>&1 || docker network create potapoff-shared >/dev/null

COMPOSE=(
  docker compose
  --env-file .env.server
  -f "$COMPOSE_FILE"
)

# Ensure SQLite busy_timeout is set for trade.db under concurrent access
export DB_BUSY_TIMEOUT="${DB_BUSY_TIMEOUT:-5000}"

ADMIN_COMPOSE=(
  docker compose
  --project-directory "$ADMIN_DIR"
  -f "$ADMIN_COMPOSE_FILE"
)

PREVIOUS_TAG=""
BOT_IMAGE_AVAILABLE=1

if [[ -f .current-image-tag ]]; then
  PREVIOUS_TAG="$(cat .current-image-tag)"
fi

telegram_intelligence_enabled() {
  local public_web
  public_web="$(resolved_backend_env_value TG_PUBLIC_WEB_ENABLED | tr '[:upper:]' '[:lower:]')"
  if [[ "$public_web" =~ ^(1|true|yes|on)$ ]]; then
    return 0
  fi

  grep -Eq '^TG_API_ID=.+$' .env.server \
    && grep -Eq '^TG_API_HASH=.+$' .env.server \
    && grep -Eq '^TG_SESSION_STRING=.+$' .env.server
}

telegram_bot_enabled() {
  grep -Eq '^TELEGRAM_BOT_TOKEN=.+$' .env.server \
    && grep -Eq '^TELEGRAM_WEBHOOK_URL=https://.+$' .env.server \
    && grep -Eq '^TELEGRAM_WEBHOOK_SECRET=[A-Za-z0-9_-]{32,256}$' .env.server
}

stop_telegram() {
  "${COMPOSE[@]}" --profile telegram stop telegram-bot \
    >/dev/null 2>&1 || true

  "${COMPOSE[@]}" --profile telegram rm -f telegram-bot \
    >/dev/null 2>&1 || true
}

sync_telegram_bot() {
  if telegram_bot_enabled && [[ "$BOT_IMAGE_AVAILABLE" -eq 1 ]]; then
    echo "Starting Telegram bot"
    "${COMPOSE[@]}" --profile telegram up -d telegram-bot
  else
    echo "Telegram bot configuration or image is unavailable; bot remains disabled"
    stop_telegram
  fi
}

sync_telegram_intelligence() {
  if telegram_intelligence_enabled; then
    echo "Starting dedicated Telegram Intelligence runtime"
    "${COMPOSE[@]}" --profile telegram-intelligence up -d telegram-intelligence
  else
    echo "Telegram Intelligence sources are not configured; runtime remains disabled"
    "${COMPOSE[@]}" --profile telegram-intelligence stop telegram-intelligence \
      >/dev/null 2>&1 || true
    "${COMPOSE[@]}" --profile telegram-intelligence rm -f telegram-intelligence \
      >/dev/null 2>&1 || true
  fi
}

restart_nginx() {
  # nginx resolves Docker service names when its configuration is loaded.
  # backend/frontend are recreated on each tagged deploy and may receive new
  # container IPs, so a long-lived nginx process can keep proxying to stale IPs.
  "${COMPOSE[@]}" restart nginx
}

start_admin() {
  echo "Starting admin Control Center"
  docker network inspect potapoff-shared >/dev/null 2>&1 || docker network create potapoff-shared >/dev/null
  "${ADMIN_COMPOSE[@]}" config --quiet
  "${ADMIN_COMPOSE[@]}" up -d --build admin-postgres admin
  for _ in $(seq 1 60); do
    if curl --fail --silent --max-time 3 http://127.0.0.1:18080/api/health >/dev/null 2>&1; then
      echo "ADMIN_HEALTH_OK"
      return 0
    fi
    sleep 2
  done
  "${ADMIN_COMPOSE[@]}" logs --tail=150 admin >&2 || true
  echo "Admin Control Center did not become healthy" >&2
  return 1
}

verify_admin_route() {
  # The public ingress and the admin app share the host port. This request
  # proves Nginx selected the admin virtual host instead of the main frontend.
  local body
  body="$(curl --fail --silent --show-error --max-time 10 -H 'Host: admin.potapoff.fun' http://127.0.0.1/api/health)"
  grep -q '"service"' <<<"$body" || {
    echo "Admin route returned an unexpected payload: $body" >&2
    return 1
  }
  echo "ADMIN_ROUTE_OK $body"
}

pull_backend_services() {
  "${COMPOSE[@]}" pull \
    backend \
    celery-worker \
    celery-market \
    celery-intelligence \
    celery-blockchain
}

rollback() {
  local exit_code=$?

  trap - ERR

  echo "Deployment failed; starting rollback" >&2

  if [[ -z "$PREVIOUS_TAG" ]]; then
    echo "No previous GHCR tag exists; manual recovery is required" >&2
    exit "$exit_code"
  fi

  printf '%s\n' "$PREVIOUS_TAG" > .current-image-tag
  export IMAGE_TAG="$PREVIOUS_TAG"

  pull_backend_services
  "${COMPOSE[@]}" pull frontend

  if telegram_bot_enabled; then
    if ! "${COMPOSE[@]}" --profile telegram pull telegram-bot; then
      BOT_IMAGE_AVAILABLE=0
      echo "Previous Telegram bot image is unavailable; continuing core rollback" >&2
    fi
  fi

  stop_telegram

  start_admin
  "${COMPOSE[@]}" up -d --remove-orphans
  restart_nginx
  sync_telegram_bot
  sync_telegram_intelligence

  SKIP_TELEGRAM_BOT_HEALTH="$((1 - BOT_IMAGE_AVAILABLE))" "$HEALTH_SCRIPT"
  verify_admin_route

  echo "ROLLBACK_OK tag=$PREVIOUS_TAG"

  exit "$exit_code"
}

trap rollback ERR

"$BACKUP_SCRIPT"

printf '%s\n' "$PREVIOUS_TAG" > .previous-image-tag
printf '%s\n' "$NEW_TAG" > .current-image-tag

export IMAGE_TAG="$NEW_TAG"

"${COMPOSE[@]}" config >/dev/null

pull_backend_services
"${COMPOSE[@]}" pull frontend

if telegram_bot_enabled; then
  "${COMPOSE[@]}" --profile telegram pull telegram-bot
fi

stop_telegram

start_admin
"${COMPOSE[@]}" up -d --remove-orphans
restart_nginx
sync_telegram_bot
sync_telegram_intelligence

"${COMPOSE[@]}" exec -T backend alembic upgrade heads

"$HEALTH_SCRIPT"
verify_admin_route

trap - ERR

docker image prune -f --filter "until=168h" >/dev/null || true

echo "DEPLOYMENT_OK tag=$NEW_TAG"
