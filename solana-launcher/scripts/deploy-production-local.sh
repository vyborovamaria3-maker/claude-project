#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${POTAPOFF_DEPLOY_WRAPPER:-}" != "1" ]]; then
  printf '[deploy] ERROR: direct execution disabled; use deploy or potapoff-deploy\n' >&2
  exit 64
fi

SOURCE_ROOT="${POTAPOFF_SOURCE_ROOT:-/opt/claude-project}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/potapoff-deploy}"
BRANCH="${POTAPOFF_DEPLOY_BRANCH:-main}"
REGISTRY_BASE="ghcr.io/vyborovamaria3-maker/claude-project"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.production.yml"
LOCAL_BUILD_FILE="$DEPLOY_DIR/docker-compose.local-build.yml"
HEALTH_SCRIPT="$DEPLOY_DIR/scripts/healthcheck-production.sh"
ADMIN_DIR="${ADMIN_DIR:-$SOURCE_ROOT/admin-site}"
ADMIN_COMPOSE_FILE="$ADMIN_DIR/docker-compose.yml"
LOCK_FILE="$DEPLOY_DIR/.deploy.lock"

log() {
  printf '[deploy] %s\n' "$*"
}

fail() {
  printf '[deploy] ERROR: %s\n' "$*" >&2
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

telegram_bot_enabled() {
  grep -Eq '^TELEGRAM_BOT_TOKEN=.+$' "$DEPLOY_DIR/.env.server" \
    && grep -Eq '^TELEGRAM_WEBHOOK_URL=https://.+$' "$DEPLOY_DIR/.env.server" \
    && grep -Eq '^TELEGRAM_WEBHOOK_SECRET=[A-Za-z0-9_-]{32,256}$' "$DEPLOY_DIR/.env.server"
}

build_service() {
  local service="$1"
  local attempt
  for attempt in 1 2; do
    log "Building $service exact-SHA image (attempt $attempt/2)"
    if "${BUILD_COMPOSE[@]}" build "$service"; then
      return 0
    fi
    [[ "$attempt" -eq 2 ]] || sleep 5
  done
  fail "production image build failed: $service"
}

require_cmd git
require_cmd docker
require_cmd curl
require_cmd install
require_cmd flock
require_cmd tar

docker compose version >/dev/null 2>&1 || fail 'docker compose plugin is required'

[[ -d "$SOURCE_ROOT/.git" ]] || fail "$SOURCE_ROOT is not a git checkout"
[[ -d "$SOURCE_ROOT/solana-launcher" ]] || fail 'solana-launcher source directory is missing'
[[ -r "$DEPLOY_DIR/.env.server" ]] || fail "$DEPLOY_DIR/.env.server is missing"
[[ -r "$DEPLOY_DIR/backend.env" ]] || fail "$DEPLOY_DIR/backend.env is missing"

mkdir -p "$DEPLOY_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  fail "another deployment is already running"
fi

cd "$SOURCE_ROOT"
if [[ -n "$(git status --porcelain)" ]]; then
  git status --short >&2
  fail "production checkout is dirty; deployment refuses to overwrite local changes"
fi

log "Fetching origin/$BRANCH"
git fetch --prune origin "$BRANCH"
git switch "$BRANCH"
git merge --ff-only "origin/$BRANCH"

DEPLOY_SHA="$(git rev-parse HEAD)"
PREVIOUS_TAG=""
[[ -r "$DEPLOY_DIR/.current-image-tag" ]] && PREVIOUS_TAG="$(cat "$DEPLOY_DIR/.current-image-tag")"

log "Target commit: $DEPLOY_SHA"
if [[ "$PREVIOUS_TAG" == "$DEPLOY_SHA" ]]; then
  log "Already deployed; running healthcheck only"
  IMAGE_TAG="$DEPLOY_SHA" "$HEALTH_SCRIPT"
  log "NO_CHANGES tag=$DEPLOY_SHA"
  exit 0
fi

mkdir -p \
  "$DEPLOY_DIR/scripts" \
  "$DEPLOY_DIR/nginx" \
  "$DEPLOY_DIR/prometheus" \
  "$DEPLOY_DIR/data"

log "Validating deployment shell syntax"
while IFS= read -r -d '' file; do
  bash -n "$file"
done < <(find "$SOURCE_ROOT/solana-launcher/scripts" -type f -name '*.sh' -print0)

log "Validating Nginx configuration"
docker run --rm \
  --add-host backend:127.0.0.1 \
  --add-host frontend:127.0.0.1 \
  --add-host potapoff-admin:127.0.0.1 \
  -v "$SOURCE_ROOT/solana-launcher/nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:1.27-alpine nginx -t >/dev/null

install -m 0644 "$SOURCE_ROOT/solana-launcher/docker-compose.production.yml" "$COMPOSE_FILE"
install -m 0644 "$SOURCE_ROOT/solana-launcher/docker-compose.local-build.yml" "$LOCAL_BUILD_FILE"
install -m 0644 "$SOURCE_ROOT/solana-launcher/nginx/nginx.conf" "$DEPLOY_DIR/nginx/nginx.conf"
install -m 0644 "$SOURCE_ROOT/solana-launcher/prometheus/prometheus.yml" "$DEPLOY_DIR/prometheus/prometheus.yml"
install -m 0700 \
  "$SOURCE_ROOT/solana-launcher/scripts/backup-production.sh" \
  "$SOURCE_ROOT/solana-launcher/scripts/healthcheck-production.sh" \
  "$SOURCE_ROOT/solana-launcher/scripts/deploy-production.sh" \
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
export ADMIN_IMAGE_TAG="$DEPLOY_SHA"
export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}"
export COMPOSE_DOCKER_CLI_BUILD="${COMPOSE_DOCKER_CLI_BUILD:-1}"

BUILD_COMPOSE=(
  docker compose
  --env-file "$DEPLOY_DIR/.env.server"
  -f "$COMPOSE_FILE"
  -f "$LOCAL_BUILD_FILE"
)

log "Validating production Compose"
"${BUILD_COMPOSE[@]}" config --quiet

[[ -f "$ADMIN_DIR/.env" ]] || fail "$ADMIN_DIR/.env must be a regular file"
[[ -f "$ADMIN_DIR/.env.intelligence" ]] || fail "$ADMIN_DIR/.env.intelligence must be a regular file"
[[ -f "$ADMIN_DIR/sources.json" ]] || fail "$ADMIN_DIR/sources.json must be a regular file"
[[ -f "$ADMIN_DIR/logs.json" ]] || fail "$ADMIN_DIR/logs.json must be a regular file"

log "Validating Control Center Compose"
docker compose --project-directory "$ADMIN_DIR" -f "$ADMIN_COMPOSE_FILE" config --quiet

# Build every artifact before backup or service switching. Docker layer cache makes
# unchanged components cheap while preserving exact-SHA, reproducible releases.
build_service backend

log "Checking backend Python bytecode and Alembic graph in the new image"
docker run --rm --entrypoint sh "$REGISTRY_BASE/backend:$DEPLOY_SHA" -lc '
  python -m compileall -q app &&
  test "$(alembic heads | sed "/^$/d" | wc -l | tr -d " ")" = "1"
'

build_service frontend

if telegram_bot_enabled; then
  build_service telegram-bot
else
  log "Telegram bot is disabled; image build skipped"
fi

log "Building Control Center before touching production"
docker compose --project-directory "$ADMIN_DIR" -f "$ADMIN_COMPOSE_FILE" build admin

ADMIN_STAGE_DIR="$SOURCE_ROOT/.admin-site-stage-$DEPLOY_SHA"
rm -rf "$ADMIN_STAGE_DIR"
mkdir -p "$ADMIN_STAGE_DIR"
trap 'rm -rf "$ADMIN_STAGE_DIR"' ERR

log "Staging Control Center source"
tar \
  --exclude='admin-site/.env' \
  --exclude='admin-site/.env.*' \
  --exclude='admin-site/sources.json' \
  --exclude='admin-site/logs.json' \
  --exclude='admin-site/__pycache__' \
  --exclude='admin-site/**/__pycache__' \
  -C "$SOURCE_ROOT" -cf - admin-site \
  | tar -C "$ADMIN_STAGE_DIR" -xf -

test -r "$ADMIN_STAGE_DIR/admin-site/docker-compose.yml"

trap - ERR
log "Preflight passed; entering backup/migration/rollback-protected rollout"
POTAPOFF_LOCAL_IMAGES=1 \
DEPLOY_DIR="$DEPLOY_DIR" \
ADMIN_ROOT="$SOURCE_ROOT" \
ADMIN_STAGE_DIR="$ADMIN_STAGE_DIR" \
  "$DEPLOY_DIR/scripts/deploy-production.sh" "$DEPLOY_SHA"

log "ONE_COMMAND_DEPLOY_OK tag=$DEPLOY_SHA"
