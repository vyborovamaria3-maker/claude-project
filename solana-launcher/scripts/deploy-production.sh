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

cd "$DEPLOY_DIR"

test -r .env.server
test -r backend.env
test -r "$COMPOSE_FILE"
test -r "$BACKUP_SCRIPT"
test -r "$HEALTH_SCRIPT"
test -r "$PROMETHEUS_CONFIG"
test -r "$ADMIN_COMPOSE_FILE"
test -r "$ADMIN_ENV_FILE"

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
    sed -i "s|^${key}=.*$|${key}=${value}|" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

ensure_twitter_crawler_admin_secret() {
  local backend_key admin_key key
  backend_key="$(env_value_from_file backend.env TWITTER_CRAWLER_ADMIN_KEY)"
  admin_key="$(env_value_from_file "$ADMIN_ENV_FILE" TWITTER_CRAWLER_ADMIN_KEY)"

  if [[ -n "$backend_key" && -n "$admin_key" && "$backend_key" != "$admin_key" ]]; then
    echo "TWITTER_CRAWLER_ADMIN_KEY differs between backend.env and admin-site/.env" >&2
    return 1
  fi

  key="${backend_key:-$admin_key}"
  if [[ -z "$key" ]]; then
    key="$(openssl rand -hex 32)"
    echo "Generated dedicated Twitter crawler admin secret"
  fi
  if [[ ! "$key" =~ ^[A-Za-z0-9_-]{32,256}$ ]]; then
    echo "TWITTER_CRAWLER_ADMIN_KEY must be 32-256 URL-safe characters" >&2
    return 1
  fi

  set_env_value backend.env TWITTER_CRAWLER_ADMIN_KEY "$key"
  set_env_value "$ADMIN_ENV_FILE" TWITTER_CRAWLER_ADMIN_KEY "$key"
  if [[ -z "$(env_value_from_file "$ADMIN_ENV_FILE" ADMIN_TWITTER_BACKEND_URL)" ]]; then
    set_env_value "$ADMIN_ENV_FILE" ADMIN_TWITTER_BACKEND_URL "http://backend:8000"
  fi
  chmod 600 backend.env "$ADMIN_ENV_FILE" 2>/dev/null || true
}

ensure_twitter_crawler_admin_secret

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

COMPOSE=(docker compose --env-file .env.server -f "$COMPOSE_FILE")
export DB_BUSY_TIMEOUT="${DB_BUSY_TIMEOUT:-5000}"
ADMIN_COMPOSE=(docker compose --project-directory "$ADMIN_DIR" -f "$ADMIN_COMPOSE_FILE")

PREVIOUS_TAG=""
BOT_IMAGE_AVAILABLE=1
TWITTER_DISCOVERY_AVAILABLE=1
[[ -f .current-image-tag ]] && PREVIOUS_TAG="$(cat .current-image-tag)"

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
  "${COMPOSE[@]}" --profile telegram stop telegram-bot >/dev/null 2>&1 || true
  "${COMPOSE[@]}" --profile telegram rm -f telegram-bot >/dev/null 2>&1 || true
}

stop_twitter_discovery() {
  "${COMPOSE[@]}" stop twitter-discovery >/dev/null 2>&1 || true
  "${COMPOSE[@]}" rm -f twitter-discovery >/dev/null 2>&1 || true
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
    "${COMPOSE[@]}" --profile telegram-intelligence stop telegram-intelligence >/dev/null 2>&1 || true
    "${COMPOSE[@]}" --profile telegram-intelligence rm -f telegram-intelligence >/dev/null 2>&1 || true
  fi
}

start_twitter_discovery_required() {
  local container_id state
  echo "Starting Twitter discovery daemon"
  "${COMPOSE[@]}" up -d twitter-discovery
  sleep 3
  container_id="$("${COMPOSE[@]}" ps -q twitter-discovery 2>/dev/null || true)"
  state=""
  [[ -n "$container_id" ]] && state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
  if [[ "$state" != "running" ]]; then
    "${COMPOSE[@]}" logs --tail=120 twitter-discovery >&2 || true
    echo "Twitter discovery daemon failed to start" >&2
    return 1
  fi
}

start_twitter_discovery_rollback() {
  local container_id state
  TWITTER_DISCOVERY_AVAILABLE=1
  if ! "${COMPOSE[@]}" up -d twitter-discovery >/dev/null 2>&1; then
    TWITTER_DISCOVERY_AVAILABLE=0
  else
    sleep 3
    container_id="$("${COMPOSE[@]}" ps -q twitter-discovery 2>/dev/null || true)"
    state=""
    [[ -n "$container_id" ]] && state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
    [[ "$state" == "running" ]] || TWITTER_DISCOVERY_AVAILABLE=0
  fi
  if [[ "$TWITTER_DISCOVERY_AVAILABLE" -ne 1 ]]; then
    echo "Previous backend image has no working Twitter discovery daemon; skipping it during rollback" >&2
    stop_twitter_discovery
  fi
}

restart_nginx() {
  "${COMPOSE[@]}" restart nginx
}

start_admin() {
  echo "Starting admin Control Center"
  docker network inspect potapoff-shared >/dev/null 2>&1 || docker network create potapoff-shared >/dev/null
  "${ADMIN_COMPOSE[@]}" config --quiet
  "${ADMIN_COMPOSE[@]}" up -d --build admin-postgres admin
  for _ in $(seq 1 60); do
    if curl --fail --silent --max-time 3 http://127.0.0.1:18080/api/ready | grep -Fq '"ready":true'; then
      echo "ADMIN_READY_OK"
      return 0
    fi
    sleep 2
  done
  "${ADMIN_COMPOSE[@]}" logs --tail=150 admin >&2 || true
  echo "Admin Control Center did not become ready" >&2
  return 1
}

verify_admin_route() {
  local body
  body="$(curl --fail --silent --show-error --max-time 10 -H 'Host: admin.potapoff.fun' http://127.0.0.1/api/health)"
  grep -q '"service"' <<<"$body" || {
    echo "Admin route returned an unexpected payload: $body" >&2
    return 1
  }
  echo "ADMIN_ROUTE_OK $body"
}

verify_twitter_admin_backend() {
  "${ADMIN_COMPOSE[@]}" exec -T admin python - <<'PY'
import os
import httpx

base = os.environ.get("ADMIN_TWITTER_BACKEND_URL", "http://backend:8000").rstrip("/")
key = os.environ.get("TWITTER_CRAWLER_ADMIN_KEY", "")
if len(key) < 32:
    raise SystemExit("TWITTER_CRAWLER_ADMIN_KEY is missing in admin container")
with httpx.Client(timeout=5.0, trust_env=False) as client:
    response = client.get(
        f"{base}/api/v1/twitter/admin/crawler-settings/access",
        headers={"X-Twitter-Crawler-Admin-Key": key},
    )
    response.raise_for_status()
    if response.json().get("ok") is not True:
        raise SystemExit("unexpected Twitter admin access payload")
print("TWITTER_ADMIN_BACKEND_OK")
PY
}

start_core_services() {
  "${COMPOSE[@]}" up -d --remove-orphans postgres redis rabbitmq backend frontend nginx prometheus
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
  "${COMPOSE[@]}" pull backend celery-worker frontend
  if ! "${COMPOSE[@]}" pull twitter-discovery; then
    TWITTER_DISCOVERY_AVAILABLE=0
    echo "Previous Twitter discovery image/command may be unavailable; continuing rollback" >&2
  fi
  if telegram_bot_enabled; then
    if ! "${COMPOSE[@]}" --profile telegram pull telegram-bot; then
      BOT_IMAGE_AVAILABLE=0
      echo "Previous Telegram bot image is unavailable; continuing core rollback" >&2
    fi
  fi

  stop_telegram
  stop_twitter_discovery
  "${COMPOSE[@]}" stop celery-worker >/dev/null 2>&1 || true
  start_admin
  start_core_services
  "${COMPOSE[@]}" up -d celery-worker
  start_twitter_discovery_rollback
  restart_nginx
  sync_telegram_bot
  sync_telegram_intelligence

  SKIP_TELEGRAM_BOT_HEALTH="$((1 - BOT_IMAGE_AVAILABLE))" \
  SKIP_TWITTER_DISCOVERY_HEALTH="$((1 - TWITTER_DISCOVERY_AVAILABLE))" \
    "$HEALTH_SCRIPT"
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
"${COMPOSE[@]}" pull backend celery-worker twitter-discovery frontend
if telegram_bot_enabled; then
  "${COMPOSE[@]}" --profile telegram pull telegram-bot
fi

stop_telegram
stop_twitter_discovery
"${COMPOSE[@]}" stop celery-worker >/dev/null 2>&1 || true

start_admin
start_core_services
restart_nginx
sync_telegram_bot
sync_telegram_intelligence

# Apply schema before any background worker can touch the new Twitter tables.
"${COMPOSE[@]}" exec -T backend alembic upgrade heads
verify_twitter_admin_backend
"${COMPOSE[@]}" up -d celery-worker
start_twitter_discovery_required

"$HEALTH_SCRIPT"
verify_admin_route
trap - ERR

docker image prune -f --filter "until=168h" >/dev/null || true
echo "DEPLOYMENT_OK tag=$NEW_TAG"
