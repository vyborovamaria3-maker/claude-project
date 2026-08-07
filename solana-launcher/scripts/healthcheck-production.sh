#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/potapoff-deploy}"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.production.yml"
IMAGE_TAG="${IMAGE_TAG:-$(cat "$DEPLOY_DIR/.current-image-tag")}"

export IMAGE_TAG

cd "$DEPLOY_DIR"

COMPOSE=(
  docker compose
  --env-file .env.server
  -f "$COMPOSE_FILE"
)

REQUIRED_SERVICES=(
  postgres
  redis
  rabbitmq
  backend
  celery-worker
  frontend
  nginx
  prometheus
)

telegram_intelligence_enabled() {
  grep -Eq '^TG_API_ID=.+$' .env.server \
    && grep -Eq '^TG_API_HASH=.+$' .env.server \
    && grep -Eq '^TG_SESSION_STRING=.+$' .env.server
}

check_services() {
  local service
  local container_id
  local state
  local health
  local bad=()

  for service in "${REQUIRED_SERVICES[@]}"; do
    container_id="$(
      "${COMPOSE[@]}" ps -q "$service" 2>/dev/null || true
    )"

    if [[ -z "$container_id" ]]; then
      bad+=("$service:missing")
      continue
    fi

    state="$(
      docker inspect \
        --format '{{.State.Status}}' \
        "$container_id" 2>/dev/null || true
    )"

    health="$(
      docker inspect \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
        "$container_id" 2>/dev/null || true
    )"

    if [[ "$state" != "running" ]]; then
      bad+=("$service:$state")
      continue
    fi

    if [[ "$health" != "none" && "$health" != "healthy" ]]; then
      bad+=("$service:$health")
    fi
  done

  if telegram_intelligence_enabled; then
    container_id="$(
      "${COMPOSE[@]}" --profile telegram-intelligence ps -q telegram-intelligence 2>/dev/null || true
    )"
    if [[ -z "$container_id" ]]; then
      bad+=("telegram-intelligence:missing")
    else
      state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
      if [[ "$state" != "running" ]]; then
        bad+=("telegram-intelligence:$state")
      fi
    fi
  fi

  printf '%s' "${bad[*]:-}"
}

for attempt in $(seq 1 45); do
  endpoints_ok=0

  if curl -fsS http://127.0.0.1/ >/dev/null \
    && curl -fsS http://127.0.0.1/miniapp >/dev/null \
    && curl -fsS http://127.0.0.1/trade/analysis >/dev/null \
    && curl -fsS http://127.0.0.1/trade/analysis/social >/dev/null \
    && curl -fsS http://127.0.0.1/fastapi/health >/dev/null; then
    endpoints_ok=1
  fi

  bad_services="$(check_services)"

  if [[ "$endpoints_ok" -eq 1 && -z "$bad_services" ]]; then
    echo "HEALTHCHECK_OK image_tag=$IMAGE_TAG social_analysis=ok"
    exit 0
  fi

  sleep 4
done

echo "HEALTHCHECK_FAILED image_tag=$IMAGE_TAG" >&2
echo "Bad services: ${bad_services:-unknown}" >&2

"${COMPOSE[@]}" ps || true

"${COMPOSE[@]}" logs \
  --tail 120 \
  postgres \
  redis \
  rabbitmq \
  backend \
  celery-worker \
  frontend \
  nginx \
  prometheus || true

if telegram_intelligence_enabled; then
  "${COMPOSE[@]}" --profile telegram-intelligence logs --tail 120 telegram-intelligence || true
fi

exit 1
