#!/usr/bin/env bash
set -Eeuo pipefail

NEW_TAG="${1:?Usage: deploy-production.sh <image-tag>}"

DEPLOY_DIR="${DEPLOY_DIR:-/opt/potapoff-deploy}"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.production.yml"
BACKUP_SCRIPT="$DEPLOY_DIR/scripts/backup-production.sh"
HEALTH_SCRIPT="$DEPLOY_DIR/scripts/healthcheck-production.sh"
PROMETHEUS_CONFIG="$DEPLOY_DIR/prometheus/prometheus.yml"

cd "$DEPLOY_DIR"

test -r .env.server
test -r backend.env
test -r "$COMPOSE_FILE"
test -r "$BACKUP_SCRIPT"
test -r "$HEALTH_SCRIPT"
test -r "$PROMETHEUS_CONFIG"

COMPOSE=(
  docker compose
  --env-file .env.server
  -f "$COMPOSE_FILE"
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

  "${COMPOSE[@]}" up -d --remove-orphans
  restart_nginx
  sync_telegram_bot
  sync_telegram_intelligence

  SKIP_TELEGRAM_BOT_HEALTH="$((1 - BOT_IMAGE_AVAILABLE))" "$HEALTH_SCRIPT"

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

"${COMPOSE[@]}" up -d --remove-orphans
restart_nginx
sync_telegram_bot
sync_telegram_intelligence

"${COMPOSE[@]}" exec -T backend alembic upgrade heads

"$HEALTH_SCRIPT"

trap - ERR

docker image prune -f --filter "until=168h" >/dev/null || true

echo "DEPLOYMENT_OK tag=$NEW_TAG"
