#!/usr/bin/env bash
set -Eeuo pipefail

NEW_TAG="${1:?Usage: deploy-production.sh <image-tag>}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/potapoff-deploy}"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.production.yml"
BACKUP_SCRIPT="$DEPLOY_DIR/scripts/backup-production.sh"
HEALTH_SCRIPT="$DEPLOY_DIR/scripts/healthcheck-production.sh"

cd "$DEPLOY_DIR"

test -r .env.server
test -r backend.env
test -r "$COMPOSE_FILE"

PREVIOUS_TAG=""
if [[ -f .current-image-tag ]]; then
  PREVIOUS_TAG="$(cat .current-image-tag)"
fi

"$BACKUP_SCRIPT"

printf '%s\n' "$PREVIOUS_TAG" > .previous-image-tag
printf '%s\n' "$NEW_TAG" > .current-image-tag
export IMAGE_TAG="$NEW_TAG"

rollback() {
  echo "Deployment failed; starting rollback" >&2

  if [[ -z "$PREVIOUS_TAG" ]]; then
    echo "No previous GHCR tag exists; leaving current containers for manual recovery" >&2
    return 1
  fi

  printf '%s\n' "$PREVIOUS_TAG" > .current-image-tag
  export IMAGE_TAG="$PREVIOUS_TAG"

  docker compose --env-file .env.server -f "$COMPOSE_FILE" pull backend celery-worker frontend telegram-bot
  docker compose --env-file .env.server -f "$COMPOSE_FILE" up -d --remove-orphans
  "$HEALTH_SCRIPT"
  echo "ROLLBACK_OK"
}

trap 'rollback' ERR

docker compose --env-file .env.server -f "$COMPOSE_FILE" config >/dev/null
docker compose --env-file .env.server -f "$COMPOSE_FILE" pull backend celery-worker frontend telegram-bot
docker compose --env-file .env.server -f "$COMPOSE_FILE" up -d --remove-orphans

docker compose --env-file .env.server -f "$COMPOSE_FILE" exec -T backend alembic upgrade heads

IMAGE_TAG="$NEW_TAG" "$HEALTH_SCRIPT"

trap - ERR

docker image prune -f --filter "until=168h" >/dev/null || true
echo "DEPLOYMENT_OK tag=$NEW_TAG"
