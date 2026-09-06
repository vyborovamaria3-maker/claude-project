#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/potapoff-deploy}"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.production.yml"
IMAGE_TAG="${IMAGE_TAG:-$(cat "$DEPLOY_DIR/.current-image-tag")}"

export IMAGE_TAG

cd "$DEPLOY_DIR"

env_value_from_file() {
  local file="$1"
  local key="$2"
  local value
  value="$(sed -n "s/^${key}=//p" "$file" | tail -n 1)"
  printf '%s' "${value%$'\r'}"
}

# docker-compose.production.yml injects this server-only secret into the
# frontend so Mini App API routes can authenticate to FastAPI. Resolve the
# same value as the backend without exposing the rest of backend.env.
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
  celery-beat
  frontend
  nginx
  prometheus
)

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

env_value() {
  local key="$1"
  env_value_from_file .env.server "$key"
}

check_telegram_webhook() {
  local token
  local webhook_url
  local webhook_secret
  local info

  token="$(env_value TELEGRAM_BOT_TOKEN)"
  webhook_url="$(env_value TELEGRAM_WEBHOOK_URL)"
  webhook_secret="$(env_value TELEGRAM_WEBHOOK_SECRET)"

  curl -fsS -H "x-webhook-secret: $webhook_secret" "$webhook_url" \
    | grep -Fq '"status":"ok"' \
    || return 1

  info="$(printf 'url = "https://api.telegram.org/bot%s/getWebhookInfo"\n' "$token" | curl -fsS --config -)" \
    || return 1

  printf '%s' "$info" | grep -Fq '"ok":true' \
    && printf '%s' "$info" | grep -Fq "\"url\":\"$webhook_url\""
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

  if telegram_bot_enabled && [[ "${SKIP_TELEGRAM_BOT_HEALTH:-0}" != "1" ]]; then
    container_id="$(
      "${COMPOSE[@]}" --profile telegram ps -q telegram-bot 2>/dev/null || true
    )"
    if [[ -z "$container_id" ]]; then
      bad+=("telegram-bot:missing")
    else
      state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
      if [[ "$state" != "running" ]]; then
        bad+=("telegram-bot:$state")
      fi
    fi
  fi

  printf '%s' "${bad[*]:-}"
}

for attempt in $(seq 1 45); do
  endpoints_ok=0
  build_info="$(curl -fsS http://127.0.0.1/api/build-info 2>/dev/null || true)"
  miniapp_config="$(curl -fsS http://127.0.0.1/api/miniapp/config 2>/dev/null || true)"

  admin_location="$(
    curl -fsSI http://127.0.0.1/admin/ 2>/dev/null \
      | tr -d '\r' \
      | awk 'tolower($1) == "location:" {print $2; exit}' \
      || true
  )"
  telegram_ok=1
  if telegram_bot_enabled \
    && [[ "${SKIP_TELEGRAM_BOT_HEALTH:-0}" != "1" ]] \
    && ! check_telegram_webhook; then
    telegram_ok=0
  fi

  if curl -fsS http://127.0.0.1/ >/dev/null \
    && curl -fsS http://127.0.0.1/miniapp >/dev/null \
    && curl -fsS http://127.0.0.1/trade/analysis >/dev/null \
    && curl -fsS http://127.0.0.1/trade/analysis/social >/dev/null \
    && curl -fsS http://127.0.0.1/fastapi/health >/dev/null \
    && printf '%s' "$miniapp_config" | grep -Fq '"monthlyPriceSol"' \
    && [[ "$admin_location" == "https://potapoff.fun/admin/login" ]] \
    && [[ "$telegram_ok" -eq 1 ]] \
    && printf '%s' "$build_info" | grep -Fq "\"buildSha\":\"$IMAGE_TAG\""; then
    endpoints_ok=1
  fi

  bad_services="$(check_services)"

  if [[ "$endpoints_ok" -eq 1 && -z "$bad_services" ]]; then
    echo "HEALTHCHECK_OK image_tag=$IMAGE_TAG social_analysis=ok miniapp_config=ok frontend_build=verified"
    exit 0
  fi

  sleep 4
done

echo "HEALTHCHECK_FAILED image_tag=$IMAGE_TAG" >&2
echo "Bad services: ${bad_services:-unknown}" >&2
echo "Build info: ${build_info:-unavailable}" >&2
echo "Mini App config: ${miniapp_config:-unavailable}" >&2

"${COMPOSE[@]}" ps || true

"${COMPOSE[@]}" logs \
  --tail 120 \
  postgres \
  redis \
  rabbitmq \
  backend \
  celery-worker \
  celery-beat \
  frontend \
  nginx \
  prometheus || true

if telegram_intelligence_enabled; then
  "${COMPOSE[@]}" --profile telegram-intelligence logs --tail 120 telegram-intelligence || true
fi

if telegram_bot_enabled; then
  "${COMPOSE[@]}" --profile telegram logs --tail 120 telegram-bot || true
fi

exit 1
