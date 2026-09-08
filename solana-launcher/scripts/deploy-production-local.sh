#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${POTAPOFF_DEPLOY_WRAPPER:-}" != "1" ]]; then
  printf '[server-deploy] ERROR: direct execution disabled; use potapoff-deploy\n' >&2
  exit 64
fi

SOURCE_ROOT="${POTAPOFF_SOURCE_ROOT:-/opt/claude-project}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/potapoff-deploy}"
BRANCH="${POTAPOFF_DEPLOY_BRANCH:-main}"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.production.yml"
LOCAL_BUILD_FILE="$DEPLOY_DIR/docker-compose.local-build.yml"
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
export ADMIN_IMAGE_TAG="$DEPLOY_SHA"

COMPOSE=(
  docker compose
  --env-file "$DEPLOY_DIR/.env.server"
  -f "$COMPOSE_FILE"
  -f "$LOCAL_BUILD_FILE"
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
  docker compose --project-directory "$ADMIN_DIR" -f "$ADMIN_COMPOSE_FILE" up -d --no-build admin-postgres admin
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
  export ADMIN_IMAGE_TAG="$PREVIOUS_TAG"
  printf '%s\n' "$PREVIOUS_TAG" > "$DEPLOY_DIR/.current-image-tag"

  if docker image inspect "admin-site-admin:$PREVIOUS_TAG" >/dev/null 2>&1; then
    docker compose --project-directory "$ADMIN_DIR" -f "$ADMIN_COMPOSE_FILE" up -d --no-build admin-postgres admin \
      || log "WARNING: admin rollback to $PREVIOUS_TAG failed"
  else
    log "WARNING: admin rollback image admin-site-admin:$PREVIOUS_TAG is missing"
  fi

  stop_telegram
  "${COMPOSE[@]}" up -d
  "${COMPOSE[@]}" restart nginx
  sync_telegram_bot
  sync_telegram_intelligence
  "$HEALTH_SCRIPT" || true

  exit "$exit_code"
}

log 'Validating compose configuration'
"${COMPOSE[@]}" config --quiet

log 'Validating admin compose configuration'
[[ -f "$ADMIN_DIR/.env" ]] || fail "$ADMIN_DIR/.env must be a regular file"
[[ -f "$ADMIN_DIR/.env.intelligence" ]] || fail "$ADMIN_DIR/.env.intelligence must be a regular file"
[[ -f "$ADMIN_DIR/sources.json" ]] || fail "$ADMIN_DIR/sources.json must be a regular file"
[[ -f "$ADMIN_DIR/logs.json" ]] || fail "$ADMIN_DIR/logs.json must be a regular file"
docker compose --project-directory "$ADMIN_DIR" -f "$ADMIN_COMPOSE_FILE" config --quiet

log "Building immutable admin image: admin-site-admin:$DEPLOY_SHA"
docker compose --project-directory "$ADMIN_DIR" -f "$ADMIN_COMPOSE_FILE" build admin

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
"${COMPOSE[@]}" up -d
"${COMPOSE[@]}" restart nginx
sync_telegram_bot
sync_telegram_intelligence

"${COMPOSE[@]}" exec -T backend alembic upgrade heads

log 'Running production healthcheck'
"$HEALTH_SCRIPT"

trap - ERR
log "DEPLOYMENT_OK tag=$DEPLOY_SHA"
