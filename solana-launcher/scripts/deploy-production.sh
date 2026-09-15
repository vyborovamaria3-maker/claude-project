#!/usr/bin/env bash
set -Eeuo pipefail

NEW_TAG="${1:?Usage: deploy-production.sh <image-tag>}"

DEPLOY_DIR="${DEPLOY_DIR:-/opt/potapoff-deploy}"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.production.yml"
BACKUP_SCRIPT="$DEPLOY_DIR/scripts/backup-production.sh"
HEALTH_SCRIPT="$DEPLOY_DIR/scripts/healthcheck-production.sh"
PROMETHEUS_CONFIG="$DEPLOY_DIR/prometheus/prometheus.yml"
ADMIN_ROOT="${ADMIN_ROOT:-/opt/claude-project}"
ADMIN_DIR="${ADMIN_DIR:-$ADMIN_ROOT/admin-site}"
ADMIN_STAGE_DIR="${ADMIN_STAGE_DIR:-$ADMIN_ROOT/.admin-site-stage-$NEW_TAG}"
ADMIN_ROLLBACK_DIR="${ADMIN_ROLLBACK_DIR:-$ADMIN_ROOT/.admin-site-rollback}"
ADMIN_COMPOSE_FILE="$ADMIN_DIR/docker-compose.yml"
ADMIN_ENV_FILE="$ADMIN_DIR/.env"
REGISTRY_BASE="ghcr.io/vyborovamaria3-maker/claude-project"

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

  # backend and worker containers load backend.env first and .env.server second.
  # A value in .env.server would therefore override the dedicated backend-only
  # credential, including an empty assignment. Keep this secret exclusively in
  # backend.env + admin-site/.env and fail before touching the deployment.
  if grep -q '^TWITTER_CRAWLER_ADMIN_KEY=' .env.server; then
    echo "Remove TWITTER_CRAWLER_ADMIN_KEY from .env.server; keep it only in backend.env and admin-site/.env" >&2
    return 1
  fi

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

resolve_backend_api_key() {
  if [[ -z "${BACKEND_API_KEY:-}" ]]; then
    BACKEND_API_KEY="$(env_value_from_file .env.server BACKEND_API_KEY)"
  fi
  if [[ -z "${BACKEND_API_KEY:-}" ]]; then
    BACKEND_API_KEY="$(env_value_from_file backend.env BACKEND_API_KEY)"
  fi
  if [[ -z "${BACKEND_API_KEY:-}" ]]; then
    echo "BACKEND_API_KEY is required in .env.server or backend.env" >&2
    return 1
  fi
  export BACKEND_API_KEY
}

COMPOSE=(docker compose --env-file .env.server -f "$COMPOSE_FILE")
export DB_BUSY_TIMEOUT="${DB_BUSY_TIMEOUT:-5000}"
ADMIN_COMPOSE=(docker compose --project-directory "$ADMIN_DIR" -f "$ADMIN_COMPOSE_FILE")

PREVIOUS_TAG=""
BOT_IMAGE_AVAILABLE=1
TWITTER_DISCOVERY_AVAILABLE=1
DEPLOYMENT_STARTED=0
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

verify_release_images() {
  local tag="$1"
  local image
  local images=(backend frontend)
  if telegram_bot_enabled; then
    images+=(telegram-bot)
  fi
  for image in "${images[@]}"; do
    if ! docker manifest inspect "$REGISTRY_BASE/$image:$tag" >/dev/null 2>&1; then
      echo "Required release image is unavailable: $REGISTRY_BASE/$image:$tag" >&2
      return 1
    fi
  done
  echo "RELEASE_IMAGES_OK tag=$tag"
}

activate_admin_source() {
  local staged="$ADMIN_STAGE_DIR/admin-site"
  local file
  test -r "$staged/docker-compose.yml"
  rm -rf "$ADMIN_ROLLBACK_DIR"
  mv "$ADMIN_DIR" "$ADMIN_ROLLBACK_DIR"
  mv "$staged" "$ADMIN_DIR"
  for file in .env .env.intelligence sources.json logs.json; do
    if [[ -e "$ADMIN_ROLLBACK_DIR/$file" ]]; then
      cp -a "$ADMIN_ROLLBACK_DIR/$file" "$ADMIN_DIR/$file"
    fi
  done
  rm -rf "$ADMIN_STAGE_DIR"
  test -r "$ADMIN_COMPOSE_FILE"
  test -r "$ADMIN_ENV_FILE"
  echo "ADMIN_SOURCE_ACTIVATED tag=$NEW_TAG"
}

restore_admin_source() {
  local failed_dir
  if [[ ! -d "$ADMIN_ROLLBACK_DIR" ]]; then
    return 0
  fi
  failed_dir="${ADMIN_DIR}.failed-$(date -u +%Y%m%d%H%M%S)"
  rm -rf "$failed_dir"
  if [[ -d "$ADMIN_DIR" ]]; then
    mv "$ADMIN_DIR" "$failed_dir"
  fi
  mv "$ADMIN_ROLLBACK_DIR" "$ADMIN_DIR"
  rm -rf "$failed_dir"
  echo "ADMIN_SOURCE_ROLLBACK_OK"
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
  restore_admin_source

  if [[ "$DEPLOYMENT_STARTED" -ne 1 ]]; then
    rm -rf "$ADMIN_STAGE_DIR"
    echo "PREFLIGHT_ROLLBACK_OK; core services were not changed" >&2
    exit "$exit_code"
  fi

  if [[ -z "$PREVIOUS_TAG" ]]; then
    echo "No previous GHCR tag exists; admin source was restored but manual core recovery is required" >&2
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
  start_core_services
  start_admin
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

# Everything before the backup is a reversible preflight. The active admin
# source is switched only under the rollback trap, and core containers are not
# touched until the backup succeeds.
verify_release_images "$NEW_TAG"
activate_admin_source
ensure_twitter_crawler_admin_secret
resolve_backend_api_key

docker network inspect potapoff-shared >/dev/null 2>&1 || docker network create potapoff-shared >/dev/null
export IMAGE_TAG="$NEW_TAG"
"${COMPOSE[@]}" config >/dev/null
"${ADMIN_COMPOSE[@]}" config --quiet

"$BACKUP_SCRIPT"
DEPLOYMENT_STARTED=1
printf '%s\n' "$PREVIOUS_TAG" > .previous-image-tag
printf '%s\n' "$NEW_TAG" > .current-image-tag

"${COMPOSE[@]}" pull backend celery-worker twitter-discovery frontend
if telegram_bot_enabled; then
  "${COMPOSE[@]}" --profile telegram pull telegram-bot
fi

# Background writers are stopped before the schema transition. The currently
# serving backend/frontend remain on the previous tag until the migration has
# completed successfully.
stop_telegram
stop_twitter_discovery
"${COMPOSE[@]}" stop celery-worker >/dev/null 2>&1 || true

# Run the new image as a one-shot migration container against the already-live
# database. This prevents new application code from seeing a pre-migration
# schema and still allows rollback because production backend startup does not
# run Alembic implicitly.
"${COMPOSE[@]}" run --rm --no-deps backend alembic upgrade heads

start_core_services
start_admin
restart_nginx
sync_telegram_bot
sync_telegram_intelligence

verify_twitter_admin_backend
"${COMPOSE[@]}" up -d celery-worker
start_twitter_discovery_required

"$HEALTH_SCRIPT"
verify_admin_route
rm -rf "$ADMIN_ROLLBACK_DIR" "$ADMIN_STAGE_DIR"
trap - ERR

docker image prune -f --filter "until=168h" >/dev/null || true
echo "DEPLOYMENT_OK tag=$NEW_TAG"
