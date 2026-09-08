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
ADMIN_ENV_FILE="$ADMIN_DIR/.env"
DEPLOY_ENV_FILE="$DEPLOY_DIR/.env.server"

cd "$DEPLOY_DIR"

test -r "$DEPLOY_ENV_FILE"
test -r backend.env
test -r "$COMPOSE_FILE"
test -r "$BACKUP_SCRIPT"
test -r "$HEALTH_SCRIPT"
test -r "$PROMETHEUS_CONFIG"
test -r "$ADMIN_COMPOSE_FILE"
test -r "$ADMIN_ENV_FILE"

command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }

env_value_from_file() {
  local file="$1"
  local key="$2"
  local value
  value="$(sed -n "s/^${key}=//p" "$file" | tail -n 1)"
  printf '%s' "${value%$'\r'}"
}

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

ensure_admin_integration_bootstrap() {
  local master helius_token telegram_token deploy_helius deploy_telegram
  master="$(env_value_from_file "$ADMIN_ENV_FILE" ADMIN_SECRETS_MASTER_KEY)"
  helius_token="$(env_value_from_file "$ADMIN_ENV_FILE" ADMIN_HELIUS_SERVICE_TOKEN)"
  telegram_token="$(env_value_from_file "$ADMIN_ENV_FILE" ADMIN_TELEGRAM_SERVICE_TOKEN)"
  deploy_helius="$(env_value_from_file "$DEPLOY_ENV_FILE" ADMIN_HELIUS_SERVICE_TOKEN)"
  deploy_telegram="$(env_value_from_file "$DEPLOY_ENV_FILE" ADMIN_TELEGRAM_SERVICE_TOKEN)"

  if [[ -z "$master" ]]; then
    master="$(openssl rand -hex 32)"
    set_env_value "$ADMIN_ENV_FILE" ADMIN_SECRETS_MASTER_KEY "$master"
    echo "Generated ADMIN_SECRETS_MASTER_KEY in admin environment"
  fi

  if [[ -z "$helius_token" && -n "$deploy_helius" ]]; then
    helius_token="$deploy_helius"
    set_env_value "$ADMIN_ENV_FILE" ADMIN_HELIUS_SERVICE_TOKEN "$helius_token"
  elif [[ -z "$helius_token" ]]; then
    helius_token="$(openssl rand -hex 32)"
    set_env_value "$ADMIN_ENV_FILE" ADMIN_HELIUS_SERVICE_TOKEN "$helius_token"
    echo "Generated scoped Helius integration service token"
  fi

  if [[ -z "$telegram_token" && -n "$deploy_telegram" ]]; then
    telegram_token="$deploy_telegram"
    set_env_value "$ADMIN_ENV_FILE" ADMIN_TELEGRAM_SERVICE_TOKEN "$telegram_token"
  elif [[ -z "$telegram_token" ]]; then
    telegram_token="$(openssl rand -hex 32)"
    set_env_value "$ADMIN_ENV_FILE" ADMIN_TELEGRAM_SERVICE_TOKEN "$telegram_token"
    echo "Generated scoped Telegram integration service token"
  fi

  if [[ "$deploy_helius" != "$helius_token" ]]; then
    set_env_value "$DEPLOY_ENV_FILE" ADMIN_HELIUS_SERVICE_TOKEN "$helius_token"
  fi
  if [[ "$deploy_telegram" != "$telegram_token" ]]; then
    set_env_value "$DEPLOY_ENV_FILE" ADMIN_TELEGRAM_SERVICE_TOKEN "$telegram_token"
  fi
  if ! grep -q '^ADMIN_INTEGRATIONS_BASE_URL=' "$DEPLOY_ENV_FILE"; then
    set_env_value "$DEPLOY_ENV_FILE" ADMIN_INTEGRATIONS_BASE_URL 'http://potapoff-admin:8080'
  fi
  chmod 600 "$ADMIN_ENV_FILE" "$DEPLOY_ENV_FILE" 2>/dev/null || true
}

ensure_admin_integration_bootstrap

# The frontend's Mini App routes make authenticated server-to-server requests
# to the FastAPI subscription endpoints. Keep backend.env private, but export
# only the shared API key so Docker Compose can inject it into the frontend.
if [[ -z "${BACKEND_API_KEY:-}" ]]; then
  BACKEND_API_KEY="$(env_value_from_file "$DEPLOY_ENV_FILE" BACKEND_API_KEY)"
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
  --env-file "$DEPLOY_ENV_FILE"
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
  local admin_token=""
  if ! grep -Eq '^TG_MONITOR_CHANNELS=.+$' "$DEPLOY_ENV_FILE"; then
    return 1
  fi
  admin_token="$(env_value_from_file "$DEPLOY_ENV_FILE" ADMIN_TELEGRAM_SERVICE_TOKEN)"
  if [[ ${#admin_token} -ge 32 ]]; then
    return 0
  fi
  grep -Eq '^TG_API_ID=.+$' "$DEPLOY_ENV_FILE" \
    && grep -Eq '^TG_API_HASH=.+$' "$DEPLOY_ENV_FILE" \
    && grep -Eq '^TG_SESSION_STRING=.+$' "$DEPLOY_ENV_FILE"
}

telegram_bot_enabled() {
  grep -Eq '^TELEGRAM_BOT_TOKEN=.+$' "$DEPLOY_ENV_FILE" \
    && grep -Eq '^TELEGRAM_WEBHOOK_URL=https://.+$' "$DEPLOY_ENV_FILE" \
    && grep -Eq '^TELEGRAM_WEBHOOK_SECRET=[A-Za-z0-9_-]{32,256}$' "$DEPLOY_ENV_FILE"
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
    echo "Telegram Intelligence monitor channels are not configured; worker remains disabled"
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
