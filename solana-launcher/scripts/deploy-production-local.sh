#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_ROOT="${POTAPOFF_SOURCE_ROOT:-/opt/claude-project}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/potapoff-deploy}"
BRANCH="${POTAPOFF_DEPLOY_BRANCH:-main}"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.production.yml"
HEALTH_SCRIPT="$DEPLOY_DIR/scripts/healthcheck-production.sh"
BACKUP_SCRIPT="$DEPLOY_DIR/scripts/backup-production.sh"
ADMIN_DIR="${ADMIN_DIR:-$SOURCE_ROOT/admin-site}"
ADMIN_COMPOSE_FILE="$ADMIN_DIR/docker-compose.yml"

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

require_cmd git
require_cmd docker
require_cmd curl
require_cmd install

docker compose version >/dev/null 2>&1 || fail 'docker compose plugin is required'

[[ -d "$SOURCE_ROOT/.git" ]] || fail "$SOURCE_ROOT is not a git checkout"
[[ -d "$SOURCE_ROOT/solana-launcher" ]] || fail 'solana-launcher source directory is missing'
[[ -r "$DEPLOY_DIR/.env.server" ]] || fail "$DEPLOY_DIR/.env.server is missing"
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

install -m 0644 \
  "$SOURCE_ROOT/solana-launcher/docker-compose.production.yml" \
  "$COMPOSE_FILE"
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

BACKEND_API_KEY="${BACKEND_API_KEY:-}"
if [[ -z "$BACKEND_API_KEY" ]]; then
  BACKEND_API_KEY="$(env_value_from_file "$DEPLOY_DIR/.env.server" BACKEND_API_KEY)"
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
  --env-file "$DEPLOY_DIR/.env.server"
  -f "$COMPOSE_FILE"
)

telegram_intelligence_enabled() {
  grep -Eq '^TG_API_ID=.+$' "$DEPLOY_DIR/.env.server" \
    && grep -Eq '^TG_API_HASH=.+$' "$DEPLOY_DIR/.env.server" \
    && grep -Eq '^TG_SESSION_STRING=.+$' "$DEPLOY_DIR/.env.server"
}

telegram_bot_enabled() {
  grep -Eq '^TELEGRAM_BOT_TOKEN=.+$' "$DEPLOY_DIR/.env.server" \
    && grep -Eq '^TELEGRAM_WEBHOOK_URL=https://.+$' "$DEPLOY_DIR/.env.server" \
    && grep -Eq '^TELEGRAM_WEBHOOK_SECRET=[A-Za-z0-9_-]{32,256}$' "$DEPLOY_DIR/.env.server"
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

trap rollback ERR

log 'Validating compose configuration'
"${COMPOSE[@]}" config --quiet

log 'Building production images on the server'
"${COMPOSE[@]}" build backend frontend telegram-bot

log 'Creating backup before switching containers'
"$BACKUP_SCRIPT"

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
