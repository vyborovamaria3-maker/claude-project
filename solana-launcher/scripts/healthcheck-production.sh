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

COMPOSE=(docker compose --env-file .env.server -f "$COMPOSE_FILE")
REQUIRED_SERVICES=(postgres redis rabbitmq backend celery-worker frontend nginx prometheus)
if [[ "${SKIP_TWITTER_DISCOVERY_HEALTH:-0}" != "1" ]]; then
  REQUIRED_SERVICES+=(twitter-discovery)
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

env_value() {
  local key="$1"
  env_value_from_file .env.server "$key"
}

check_telegram_webhook() {
  local webhook_url webhook_secret webhook_host webhook_path container_id state
  webhook_url="$(env_value TELEGRAM_WEBHOOK_URL)"
  webhook_secret="$(env_value TELEGRAM_WEBHOOK_SECRET)"
  webhook_host="${webhook_url#*://}"
  webhook_host="${webhook_host%%/*}"
  webhook_host="${webhook_host%%:*}"
  webhook_path="${webhook_url#*://}"
  webhook_path="/${webhook_path#*/}"
  [[ -n "$webhook_host" ]] || return 1
  [[ "$webhook_path" == /* ]] || return 1
  curl --connect-timeout 3 --max-time 8 -fsS \
    -H "Host: $webhook_host" \
    -H "x-webhook-secret: $webhook_secret" \
    "http://127.0.0.1$webhook_path" \
    | grep -Fq '"status":"ok"' || return 1
  container_id="$("${COMPOSE[@]}" --profile telegram ps -q telegram-bot 2>/dev/null || true)"
  [[ -n "$container_id" ]] || return 1
  state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
  [[ "$state" == "running" ]]
}

check_twitter_settings_write() {
  "${COMPOSE[@]}" exec -T backend python - <<'PY'
import os

import httpx

fields = (
    "enabled",
    "query_limit",
    "process_limit",
    "batch_size",
    "max_depth",
    "min_relevance",
    "network_mode",
    "network_limit",
    "lease_seconds",
    "rescore_limit",
    "public_enabled",
    "public_dexscreener_latest",
    "public_dexscreener_boosts",
    "public_db_solana_tokens",
    "public_cmc_limit",
    "public_rescore_limit",
)
key = os.environ.get("TWITTER_CRAWLER_ADMIN_KEY", "").strip()
if len(key) < 32:
    raise SystemExit("TWITTER_CRAWLER_ADMIN_KEY is missing in backend container")
headers = {"X-Twitter-Crawler-Admin-Key": key}
url = "http://127.0.0.1:8000/api/v1/twitter/admin/crawler-settings"


def read_payload(client: httpx.Client) -> dict:
    response = client.get(url, headers=headers)
    response.raise_for_status()
    body = response.json()
    settings = body.get("settings") or {}
    if body.get("ok") is not True or not settings.get("updated_at"):
        raise SystemExit("unexpected Twitter crawler settings read payload")
    return {
        "expected_updated_at": settings["updated_at"],
        **{field: settings[field] for field in fields},
    }


with httpx.Client(timeout=5.0, trust_env=False) as client:
    payload = None
    written = None
    for attempt in range(2):
        payload = read_payload(client)
        write = client.put(url, headers=headers, json=payload)
        if write.status_code == 409 and attempt == 0:
            # A real admin may have saved between our GET and PUT. Re-read once
            # instead of rolling back an otherwise healthy release.
            continue
        write.raise_for_status()
        written = write.json()
        break

    if payload is None or written is None or written.get("ok") is not True:
        raise SystemExit("Twitter crawler settings no-op write did not succeed")
    written_settings = written.get("settings") or {}
    for field in fields:
        if written_settings.get(field) != payload[field]:
            raise SystemExit(f"Twitter crawler settings smoke changed {field} unexpectedly")

    # Reusing the successfully consumed version token must be rejected even if
    # another admin writes after our no-op update.
    stale = client.put(url, headers=headers, json=payload)
    if stale.status_code != 409:
        raise SystemExit(
            f"Twitter crawler optimistic-lock smoke expected 409, got {stale.status_code}"
        )
print("TWITTER_SETTINGS_WRITE_SMOKE_OK")
PY
}

check_services() {
  local service container_id state health
  local bad=()
  for service in "${REQUIRED_SERVICES[@]}"; do
    container_id="$("${COMPOSE[@]}" ps -q "$service" 2>/dev/null || true)"
    if [[ -z "$container_id" ]]; then
      bad+=("$service:missing")
      continue
    fi
    state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id" 2>/dev/null || true)"
    if [[ "$state" != "running" ]]; then
      bad+=("$service:$state")
      continue
    fi
    if [[ "$health" != "none" && "$health" != "healthy" ]]; then
      bad+=("$service:$health")
    fi
  done

  if telegram_intelligence_enabled; then
    container_id="$("${COMPOSE[@]}" --profile telegram-intelligence ps -q telegram-intelligence 2>/dev/null || true)"
    if [[ -z "$container_id" ]]; then
      bad+=("telegram-intelligence:missing")
    else
      state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
      [[ "$state" == "running" ]] || bad+=("telegram-intelligence:$state")
    fi
  fi

  if telegram_bot_enabled && [[ "${SKIP_TELEGRAM_BOT_HEALTH:-0}" != "1" ]]; then
    container_id="$("${COMPOSE[@]}" --profile telegram ps -q telegram-bot 2>/dev/null || true)"
    if [[ -z "$container_id" ]]; then
      bad+=("telegram-bot:missing")
    else
      state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
      [[ "$state" == "running" ]] || bad+=("telegram-bot:$state")
    fi
  fi
  printf '%s' "${bad[*]:-}"
}

for attempt in $(seq 1 45); do
  endpoints_ok=0
  build_info="$(curl -fsS http://127.0.0.1/api/build-info 2>/dev/null || true)"
  miniapp_config="$(curl -fsS http://127.0.0.1/api/miniapp/config 2>/dev/null || true)"
  admin_ok=0
  if curl --connect-timeout 3 --max-time 8 -fsS -H 'Host: admin.potapoff.fun' http://127.0.0.1/ >/dev/null 2>&1; then
    admin_ok=1
  fi
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
    && [[ "$admin_ok" -eq 1 ]] \
    && [[ "$telegram_ok" -eq 1 ]] \
    && printf '%s' "$build_info" | grep -Fq "\"buildSha\":\"$IMAGE_TAG\""; then
    endpoints_ok=1
  fi

  bad_services="$(check_services)"
  if [[ "$endpoints_ok" -eq 1 && -z "$bad_services" ]]; then
    if [[ "${SKIP_TWITTER_DISCOVERY_HEALTH:-0}" == "1" ]]; then
      discovery_status="skipped"
      twitter_settings_status="skipped"
    else
      discovery_status="running"
      if check_twitter_settings_write; then
        twitter_settings_status="write_conflict_ok"
      else
        twitter_settings_status="failed"
      fi
    fi
    if [[ "$twitter_settings_status" != "failed" ]]; then
      echo "HEALTHCHECK_OK image_tag=$IMAGE_TAG social_analysis=ok miniapp_config=ok twitter_discovery=$discovery_status twitter_settings=$twitter_settings_status frontend_build=verified"
      exit 0
    fi
  fi
  sleep 4
done

echo "HEALTHCHECK_FAILED image_tag=$IMAGE_TAG" >&2
echo "Bad services: ${bad_services:-unknown}" >&2
echo "Build info: ${build_info:-unavailable}" >&2
echo "Mini App config: ${miniapp_config:-unavailable}" >&2
"${COMPOSE[@]}" ps || true
"${COMPOSE[@]}" logs --tail 120 postgres redis rabbitmq backend celery-worker twitter-discovery frontend nginx prometheus || true
if telegram_intelligence_enabled; then
  "${COMPOSE[@]}" --profile telegram-intelligence logs --tail 120 telegram-intelligence || true
fi
if telegram_bot_enabled; then
  "${COMPOSE[@]}" --profile telegram logs --tail 120 telegram-bot || true
fi
exit 1
