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

resolve_env_value() {
  local key="$1"
  local value="${!key:-}"
  if [[ -z "$value" ]]; then
    value="$(env_value_from_file .env.server "$key")"
  fi
  if [[ -z "$value" ]]; then
    value="$(env_value_from_file backend.env "$key")"
  fi
  printf '%s' "$value"
}

# Values used by Compose interpolation must exist in the deploy shell itself.
# backend.env remains private; only explicitly selected server-side values are
# exported here. None of these are NEXT_PUBLIC_* browser variables.
BACKEND_API_KEY="$(resolve_env_value BACKEND_API_KEY)"
if [[ -z "$BACKEND_API_KEY" ]]; then
  echo "BACKEND_API_KEY is required in .env.server or backend.env" >&2
  exit 1
fi
export BACKEND_API_KEY

KOL_INTERNAL_KEY="$(resolve_env_value KOL_INTERNAL_KEY)"
if [[ -z "$KOL_INTERNAL_KEY" ]]; then
  echo "KOL_INTERNAL_KEY is required in .env.server or backend.env" >&2
  exit 1
fi
if (( ${#KOL_INTERNAL_KEY} < 32 )); then
  echo "KOL_INTERNAL_KEY must be at least 32 characters" >&2
  exit 1
fi
if [[ "$KOL_INTERNAL_KEY" == "$BACKEND_API_KEY" ]]; then
  echo "KOL_INTERNAL_KEY must be different from BACKEND_API_KEY" >&2
  exit 1
fi
export KOL_INTERNAL_KEY

# Solana Tracker ingestion is optional: when the key is absent, the KOL UI
# explicitly reports ingestion_disabled instead of pretending there were no
# trades. If configured in backend.env, export it so Compose does not overwrite
# the env_file value with an empty interpolation result.
SOLANA_TRACKER_API_KEY="$(resolve_env_value SOLANA_TRACKER_API_KEY)"
SOLANA_TRACKER_API_BASE="$(resolve_env_value SOLANA_TRACKER_API_BASE)"
KOL_TRADE_SYNC_INTERVAL_SECONDS="$(resolve_env_value KOL_TRADE_SYNC_INTERVAL_SECONDS)"
KOL_TRADE_SYNC_WALLETS_PER_RUN="$(resolve_env_value KOL_TRADE_SYNC_WALLETS_PER_RUN)"
export SOLANA_TRACKER_API_KEY
export SOLANA_TRACKER_API_BASE="${SOLANA_TRACKER_API_BASE:-https://data.solanatracker.io}"
export KOL_TRADE_SYNC_INTERVAL_SECONDS="${KOL_TRADE_SYNC_INTERVAL_SECONDS:-1200}"
export KOL_TRADE_SYNC_WALLETS_PER_RUN="${KOL_TRADE_SYNC_WALLETS_PER_RUN:-1}"

if [[ -n "$SOLANA_TRACKER_API_KEY" ]]; then
  echo "KOL trade ingestion provider: enabled"
else
  echo "KOL trade ingestion provider: disabled (SOLANA_TRACKER_API_KEY is not configured)"
fi

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
    echo "Starting Telegram Intelligence worker"
    "${COMPOSE[@]}" --profile telegram-intelligence up -d telegram-intelligence
  else
    echo "Telegram Intelligence credentials are not configured; worker remains disabled"
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

  "${COMPOSE[@]}" pull \
    backend \
    celery-worker \
    frontend

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

"${COMPOSE[@]}" pull \
  backend \
  celery-worker \
  frontend

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
