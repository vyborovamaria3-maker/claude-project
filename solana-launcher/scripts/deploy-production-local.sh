#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_ROOT="${POTAPOFF_SOURCE_ROOT:-/opt/claude-project}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/potapoff-deploy}"
BRANCH="${POTAPOFF_DEPLOY_BRANCH:-main}"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.production.yml"
LOCAL_BUILD_FILE="$DEPLOY_DIR/docker-compose.local-build.yml"
HEALTH_SCRIPT="$DEPLOY_DIR/scripts/healthcheck-production.sh"
BACKUP_SCRIPT="$DEPLOY_DIR/scripts/backup-production.sh"
ADMIN_DIR="${ADMIN_DIR:-$SOURCE_ROOT/admin-site}"
ADMIN_COMPOSE_FILE="$ADMIN_DIR/docker-compose.yml"
ADMIN_ENV_FILE="$ADMIN_DIR/.env"
DEPLOY_ENV_FILE="$DEPLOY_DIR/.env.server"

log() {
  printf '[server-deploy] %s\n' "$*"
}

fail() {
  printf '[server-deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

env_value_from_file() {
  local file="$1"
  local key="$2"
  local value=""
  [[ -r "$file" ]] || return 0
  value="$(sed -n "s/^${key}=//p" "$file" | tail -n 1)"
  printf '%s' "${value%$'\r'}"
}

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  [[ -f "$file" ]] || fail "$file is missing"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

ensure_admin_integration_bootstrap() {
  [[ -r "$ADMIN_ENV_FILE" ]] || fail "$ADMIN_ENV_FILE is missing"
  [[ -r "$DEPLOY_ENV_FILE" ]] || fail "$DEPLOY_ENV_FILE is missing"

  local master helius_token telegram_token deploy_helius deploy_telegram
  master="$(env_value_from_file "$ADMIN_ENV_FILE" ADMIN_SECRETS_MASTER_KEY)"
  helius_token="$(env_value_from_file "$ADMIN_ENV_FILE" ADMIN_HELIUS_SERVICE_TOKEN)"
  telegram_token="$(env_value_from_file "$ADMIN_ENV_FILE" ADMIN_TELEGRAM_SERVICE_TOKEN)"
  deploy_helius="$(env_value_from_file "$DEPLOY_ENV_FILE" ADMIN_HELIUS_SERVICE_TOKEN)"
  deploy_telegram="$(env_value_from_file "$DEPLOY_ENV_FILE" ADMIN_TELEGRAM_SERVICE_TOKEN)"

  if [[ -z "$master" ]]; then
    master="$(openssl rand -hex 32)"
    set_env_value "$ADMIN_ENV_FILE" ADMIN_SECRETS_MASTER_KEY "$master"
    log 'Generated ADMIN_SECRETS_MASTER_KEY in admin environment'
  fi

  if [[ -z "$helius_token" && -n "$deploy_helius" ]]; then
    helius_token="$deploy_helius"
    set_env_value "$ADMIN_ENV_FILE" ADMIN_HELIUS_SERVICE_TOKEN "$helius_token"
  elif [[ -z "$helius_token" ]]; then
    helius_token="$(openssl rand -hex 32)"
    set_env_value "$ADMIN_ENV_FILE" ADMIN_HELIUS_SERVICE_TOKEN "$helius_token"
    log 'Generated scoped Helius integration service token'
  fi

  if [[ -z "$telegram_token" && -n "$deploy_telegram" ]]; then
    telegram_token="$deploy_telegram"
    set_env_value "$ADMIN_ENV_FILE" ADMIN_TELEGRAM_SERVICE_TOKEN "$telegram_token"
  elif [[ -z "$telegram_token" ]]; then
    telegram_token="$(openssl rand -hex 32)"
    set_env_value "$ADMIN_ENV_FILE" ADMIN_TELEGRAM_SERVICE_TOKEN "$telegram_token"
    log 'Generated scoped Telegram integration service token'
  fi

  # Admin is the source of truth once initialized. Keep runtime consumers in
  # sync without printing any secret value to stdout/stderr.
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
  log 'Admin integration bootstrap verified'
}

require_cmd git
require_cmd docker
require_cmd curl
require_cmd install
require_cmd openssl

docker compose version >/dev/null 2>&1 || fail 'docker compose plugin is required'

[[ -d "$SOURCE_ROOT/.git" ]] || fail "$SOURCE_ROOT is not a git checkout"
[[ -d "$SOURCE_ROOT/solana-launcher" ]] || fail 'solana-launcher source directory is missing'
[[ -r "$DEPLOY_ENV_FILE" ]] || fail "$DEPLOY_ENV_FILE is missing"
[[ -r "$DEPLOY_DIR/backend.env" ]] || fail "$DEPLOY_DIR/backend.env is missing"

cd "$SOURCE_ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
  fail "production checkout is dirty; commit/stash local changes before deployment"
fi

log "Updating $BRANCH with fast-forward only"
git fetch --prune origin "$BRANCH"
git switch "$BRANCH"
git merge --ff-only "origin/$BRANCH"

DEPLOY_SHA="$(git rev-parse HEAD)"
PREVIOUS_TAG=""
if [[ -r "$DEPLOY_DIR/.current-image-tag" ]]; then
  PREVIOUS_TAG="$(cat "$DEPLOY_DIR/.current-image-tag")"
fi

log "Deploying commit $DEPLOY_SHA"

mkdir -p \
  "$DEPLOY_DIR/scripts" \
  "$DEPLOY_DIR/nginx" \
  "$DEPLOY_DIR/prometheus" \
  "$DEPLOY_DIR/data"

log 'Validating Nginx configuration before touching production'
docker run --rm \
  --add-host backend:127.0.0.1 \
  --add-host frontend:127.0.0.1 \
  --add-host potapoff-admin:127.0.0.1 \
  -v "$SOURCE_ROOT/solana-launcher/nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:1.27-alpine nginx -t >/dev/null

install -m 0644 \
  "$SOURCE_ROOT/solana-launcher/docker-compose.production.yml" \
  "$COMPOSE_FILE"
install -m 0644 \
  "$SOURCE_ROOT/solana-launcher/docker-compose.local-build.yml" \
  "$LOCAL_BUILD_FILE"

ensure_admin_integration_bootstrap

BACKEND_API_KEY="${BACKEND_API_KEY:-}"
if [[ -z "$BACKEND_API_KEY" ]]; then
  BACKEND_API_KEY="$(env_value_from_file "$DEPLOY_ENV_FILE" BACKEND_API_KEY)"
fi
if [[ -z "$BACKEND_API_KEY" ]]; then
  BACKEND_API_KEY="$(env_value_from_file "$DEPLOY_DIR/backend.env" BACKEND_API_KEY)"
fi
[[ -n "$BACKEND_API_KEY" ]] || fail 'BACKEND_API_KEY is required in .env.server or backend.env'

export BACKEND_API_KEY
export POTAPOFF_SOURCE_ROOT="$SOURCE_ROOT"
export IMAGE_TAG="$DEPLOY_SHA"

COMPOSE=(
  docker compose
  --env-file "$DEPLOY_ENV_FILE"
  -f "$COMPOSE_FILE"
  -f "$LOCAL_BUILD_FILE"
)

telegram_intelligence_enabled() {
  local admin_token=""
  admin_token="$(env_value_from_file "$DEPLOY_ENV_FILE" ADMIN_TELEGRAM_SERVICE_TOKEN)"
  grep -Eq '^TG_MONITOR_CHANNELS=.+$' "$DEPLOY_ENV_FILE" \
    && {
      [[ ${#admin_token} -ge 32 ]] \
        || {
          grep -Eq '^TG_API_ID=.+$' "$DEPLOY_ENV_FILE" \
            && grep -Eq '^TG_API_HASH=.+$' "$DEPLOY_ENV_FILE" \
            && grep -Eq '^TG_SESSION_STRING=.+$' "$DEPLOY_ENV_FILE"
        ; }
    ; }
}

telegram_bot_enabled() {
  grep -Eq '^TELEGRAM_BOT_TOKEN=.+$' "$DEPLOY_ENV_FILE" \
    && grep -Eq '^TELEGRAM_WEBHOOK_URL=https://.+$' "$DEPLOY_ENV_FILE" \
    && grep -Eq '^TELEGRAM_WEBHOOK_SECRET=[A-Za-z0-9_-]{32,256}$' "$DEPLOY_ENV_FILE"
}

stop_telegram() {
  "${COMPOSE[@]}" --profile telegram stop telegram-bot >/dev/null 2>&1 || true
  "${COMPOSE[@]}" --profile telegram rm -f telegram-bot >/dev/null 2>&1 || true
}

sync_telegram_bot() {
  if telegram_bot_enabled; then
    "${COMPOSE[@]}" --profile telegram up -d telegram-bot
  else
    stop_telegram
  fi
}

sync_telegram_intelligence() {
  if telegram_intelligence_enabled; then
    "${COMPOSE[@]}" --profile telegram-intelligence up -d telegram-intelligence
  else
    "${COMPOSE[@]}" --profile telegram-intelligence stop telegram-intelligence >/dev/null 2>&1 || true
    "${COMPOSE[@]}" --profile telegram-intelligence rm -f telegram-intelligence >/dev/null 2>&1 || true
  fi
}

start_admin() {
  [[ -r "$ADMIN_COMPOSE_FILE" ]] || fail "$ADMIN_COMPOSE_FILE is missing"
  docker network inspect potapoff-shared >/dev/null 2>&1 || docker network create potapoff-shared >/dev/null
  docker compose --project-directory "$ADMIN_DIR" -f "$ADMIN_COMPOSE_FILE" config --quiet
  docker compose --project-directory "$ADMIN_DIR" -f "$ADMIN_COMPOSE_FILE" up -d --build admin-postgres admin
}

rollback() {
  local exit_code=$?
  trap - ERR

  if [[ -z "$PREVIOUS_TAG" ]]; then
    log 'Deployment failed and there is no previous image tag for automatic rollback'
    exit "$exit_code"
  fi

  log "Deployment failed; rolling back to $PREVIOUS_TAG"
  export IMAGE_TAG="$PREVIOUS_TAG"
  printf '%s\n' "$PREVIOUS_TAG" > "$DEPLOY_DIR/.current-image-tag"

  stop_telegram
  "${COMPOSE[@]}" up -d --remove-orphans
  "${COMPOSE[@]}" restart nginx
  sync_telegram_bot
  sync_telegram_intelligence
  "$HEALTH_SCRIPT" || true

  exit "$exit_code"
}

log 'Validating compose configuration'
"${COMPOSE[@]}" config --quiet

log 'Building production images on the server sequentially to limit memory usage'
for service in backend frontend telegram-bot; do
  log "Building production image: $service"
  build_ok=0
  for attempt in 1 2; do
    if "${COMPOSE[@]}" build "$service"; then
      build_ok=1
      break
    fi
    if [[ "$attempt" -lt 2 ]]; then
      log "Build failed for $service; retrying in 20 seconds (cached layers will be reused)"
      sleep 20
    fi
  done
  if [[ "$build_ok" -ne 1 ]]; then
    fail "Build failed for $service after 2 attempts; running production was left untouched"
  fi
done

log 'Creating backup before switching containers'
"$BACKUP_SCRIPT"

# Only arm rollback after every image has built and the pre-deploy backup is
# complete. Build/download failures must never restart a healthy production
# stack.
trap rollback ERR

install -m 0644 \
  "$SOURCE_ROOT/solana-launcher/nginx/nginx.conf" \
  "$DEPLOY_DIR/nginx/nginx.conf"
install -m 0644 \
  "$SOURCE_ROOT/solana-launcher/prometheus/prometheus.yml" \
  "$DEPLOY_DIR/prometheus/prometheus.yml"
install -m 0700 \
  "$SOURCE_ROOT/solana-launcher/scripts/backup-production.sh" \
  "$SOURCE_ROOT/solana-launcher/scripts/healthcheck-production.sh" \
  "$SOURCE_ROOT/solana-launcher/scripts/deploy-production.sh" \
  "$SOURCE_ROOT/solana-launcher/scripts/deploy-production-local.sh" \
  "$DEPLOY_DIR/scripts/"

printf '%s\n' "$PREVIOUS_TAG" > "$DEPLOY_DIR/.previous-image-tag"
printf '%s\n' "$DEPLOY_SHA" > "$DEPLOY_DIR/.current-image-tag"

start_admin
stop_telegram
"${COMPOSE[@]}" up -d --remove-orphans
"${COMPOSE[@]}" restart nginx
sync_telegram_bot
sync_telegram_intelligence

"${COMPOSE[@]}" exec -T backend alembic upgrade heads

log 'Running production healthcheck'
"$HEALTH_SCRIPT"

trap - ERR
log "DEPLOYMENT_OK tag=$DEPLOY_SHA"
