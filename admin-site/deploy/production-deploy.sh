#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

MODE="${1:-preflight}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd -- "$ADMIN_DIR/.." && pwd)"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/potapoff-admin}"
EXPECTED_ORIGIN="${EXPECTED_ORIGIN:-https://admin.potapoff.fun}"
EXPECTED_COMMIT="${EXPECTED_COMMIT:-}"
COMPOSE=(docker compose --project-directory "$ADMIN_DIR" -f "$ADMIN_DIR/docker-compose.yml")

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }

env_get() {
  local key="$1"
  awk -v key="$key" '
    index($0, key "=") == 1 {
      value=$0; sub(/^[^=]*=/, "", value); print value; exit
    }
  ' "$ADMIN_DIR/.env"
}

require_nonempty() {
  local key="$1" value
  value="$(env_get "$key")"
  [[ -n "${value//[[:space:]]/}" ]] || die "$key must be set in admin-site/.env"
}

require_true() {
  local key="$1" value
  value="$(env_get "$key" | tr '[:upper:]' '[:lower:]')"
  [[ "$value" =~ ^(1|true|yes|on)$ ]] || die "$key must be true in production"
}

container_health() {
  local name="$1"
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || true
}

wait_healthy() {
  local name="$1" timeout="${2:-120}" started now status
  started="$(date +%s)"
  while true; do
    status="$(container_health "$name")"
    case "$status" in
      healthy|running) log "$name status=$status"; return 0 ;;
      unhealthy|exited|dead) docker logs --tail=120 "$name" >&2 || true; die "$name became $status" ;;
    esac
    now="$(date +%s)"
    (( now - started < timeout )) || { docker logs --tail=120 "$name" >&2 || true; die "timeout waiting for $name health"; }
    sleep 2
  done
}

preflight() {
  need docker; need git; need curl; need awk; need grep; need sed; need openssl; need df
  docker info >/dev/null 2>&1 || die "Docker daemon is not reachable"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"

  [[ -f "$ADMIN_DIR/.env" ]] || die "missing $ADMIN_DIR/.env"
  [[ -f "$ADMIN_DIR/.env.intelligence" ]] || die "missing $ADMIN_DIR/.env.intelligence"
  [[ -f "$ADMIN_DIR/sources.json" ]] || die "missing $ADMIN_DIR/sources.json"
  [[ -f "$ADMIN_DIR/logs.json" ]] || die "missing $ADMIN_DIR/logs.json"

  [[ "$(env_get ADMIN_ENVIRONMENT)" == "production" ]] || die "ADMIN_ENVIRONMENT must be production"
  require_nonempty ADMIN_PASSWORD_HASH
  require_nonempty ADMIN_SESSION_SECRET
  require_nonempty ADMIN_TOTP_SECRET
  require_nonempty ADMIN_STATE_DB_PASSWORD
  require_nonempty ADMIN_ALLOWED_NETWORKS
  require_nonempty ADMIN_ALLOWED_ORIGINS
  require_true ADMIN_SECURE_COOKIE
  require_true ADMIN_REQUIRE_MFA
  require_true ADMIN_REQUIRE_REAUTH
  require_true ADMIN_REQUIRE_NETWORK_ALLOWLIST
  require_true ADMIN_SESSION_BIND_IP
  require_true ADMIN_SESSION_BIND_USER_AGENT

  [[ -z "$(env_get ADMIN_PASSWORD)" ]] || die "ADMIN_PASSWORD must be empty in production"
  [[ "$(env_get ADMIN_SHOW_SENSITIVE | tr '[:upper:]' '[:lower:]')" != "true" ]] || die "ADMIN_SHOW_SENSITIVE must be false"
  [[ "$(env_get ADMIN_ALLOWED_ORIGINS)" == *"$EXPECTED_ORIGIN"* ]] || die "ADMIN_ALLOWED_ORIGINS must include $EXPECTED_ORIGIN"

  local session_secret state_password allowed_networks workers free_kb
  session_secret="$(env_get ADMIN_SESSION_SECRET)"
  state_password="$(env_get ADMIN_STATE_DB_PASSWORD)"
  allowed_networks="$(env_get ADMIN_ALLOWED_NETWORKS)"
  workers="$(env_get ADMIN_WEB_WORKERS)"; workers="${workers:-1}"
  [[ ${#session_secret} -ge 32 ]] || die "ADMIN_SESSION_SECRET must be at least 32 characters"
  [[ ${#state_password} -ge 24 ]] || die "ADMIN_STATE_DB_PASSWORD should be at least 24 characters"
  [[ "$workers" =~ ^[1-8]$ ]] || die "ADMIN_WEB_WORKERS must be between 1 and 8"

  # The container healthcheck calls /api/ready directly from 127.0.0.1. Keep
  # loopback in the allowlist in addition to the real operator/VPN CIDR.
  [[ ",$allowed_networks," =~ ,[^,]*127\.0\.0\.[^,]*, ]] || die "ADMIN_ALLOWED_NETWORKS must also include 127.0.0.1/32 for the internal readiness healthcheck"

  if [[ -n "$EXPECTED_COMMIT" ]]; then
    [[ "$(git -C "$REPO_DIR" rev-parse HEAD)" == "$EXPECTED_COMMIT" ]] || die "HEAD does not match EXPECTED_COMMIT=$EXPECTED_COMMIT"
  fi
  [[ -z "$(git -C "$REPO_DIR" status --porcelain --untracked-files=no)" ]] || die "tracked files are modified; deploy from a clean checkout"

  "${COMPOSE[@]}" config --quiet
  local rendered
  rendered="$("${COMPOSE[@]}" config)"
  grep -q '127.0.0.1:18080' <<<"$rendered" || die "admin port must remain bound to 127.0.0.1:18080"
  ! grep -Eq 'published: "?5432"?' <<<"$rendered" || die "PostgreSQL must not be published publicly"

  free_kb="$(df -Pk "$REPO_DIR" | awk 'NR==2 {print $4}')"
  [[ "$free_kb" =~ ^[0-9]+$ ]] || die "could not determine free disk space"
  (( free_kb >= 2097152 )) || die "less than 2 GiB free disk space"

  if command -v nginx >/dev/null 2>&1; then
    nginx -t >/dev/null 2>&1 || die "existing nginx configuration is invalid before deploy"
  fi

  log "preflight OK; commit=$(git -C "$REPO_DIR" rev-parse --short=12 HEAD), workers=$workers"
}

backup_state() {
  local stamp dir
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dir="$BACKUP_ROOT/$stamp"
  install -d -m 0700 "$BACKUP_ROOT" "$dir"
  git -C "$REPO_DIR" rev-parse HEAD > "$dir/git-sha.txt"
  for file in .env .env.intelligence sources.json logs.json; do
    if [[ -f "$ADMIN_DIR/$file" ]]; then
      cp -a "$ADMIN_DIR/$file" "$dir/$file"
      chmod 0600 "$dir/$file" || true
    fi
  done
  docker inspect potapoff-admin > "$dir/potapoff-admin.inspect.json" 2>/dev/null || true
  docker inspect potapoff-intelligence > "$dir/potapoff-intelligence.inspect.json" 2>/dev/null || true
  if docker inspect potapoff-admin >/dev/null 2>&1; then
    docker cp potapoff-admin:/var/lib/potapoff-admin/audit.db "$dir/audit.db" 2>/dev/null || true
  fi
  printf '%s\n' "$dir" > "$BACKUP_ROOT/LATEST"
  log "backup created: $dir"
}

verify_sources() {
  log "verifying every configured product data source from the new admin image"
  "${COMPOSE[@]}" run --rm --no-deps admin python - <<'PY'
from app.config import Settings
from app.database import SourceRegistry

settings = Settings.load()
settings.validate()
registry = SourceRegistry(settings.sources, show_sensitive=False)
failed = []
try:
    for source in registry.all():
        try:
            tables = source.tables()
            print(f"SOURCE_OK id={source.config.id} kind={source.config.kind} tables={len(tables)}")
        except Exception as exc:
            print(f"SOURCE_FAIL id={source.config.id} kind={source.config.kind} error={type(exc).__name__}")
            failed.append(source.config.id)
finally:
    close = getattr(registry, "close", None)
    if callable(close):
        close()
if failed:
    raise SystemExit("unreachable data sources: " + ",".join(failed))
PY
}

migrate_admin_state() {
  if "${COMPOSE[@]}" run --rm --no-deps admin sh -c 'test -f "$ADMIN_AUDIT_DB"'; then
    log "migrating SQLite admin state to shared PostgreSQL"
    "${COMPOSE[@]}" run --rm --no-deps admin python scripts/migrate_admin_state_to_postgres.py
  else
    log "no legacy SQLite admin state found; migration skipped"
  fi
}

smoke() {
  log "running local smoke checks"
  curl --fail --silent --show-error --max-time 5 http://127.0.0.1:18080/api/health >/dev/null
  "${COMPOSE[@]}" exec -T admin python - <<'PY'
import json
import urllib.request
with urllib.request.urlopen("http://127.0.0.1:8080/api/ready", timeout=5) as response:
    payload = json.load(response)
if response.status != 200 or not payload.get("ready"):
    raise SystemExit(f"readiness failed: {payload}")
print("ADMIN_READY", json.dumps(payload, sort_keys=True))
PY
  "${COMPOSE[@]}" exec -T intelligence-worker python -m intelligence runtime-health
  "${COMPOSE[@]}" ps
  if command -v nginx >/dev/null 2>&1 && [[ -f /etc/letsencrypt/live/admin.potapoff.fun/fullchain.pem ]]; then
    curl --fail --silent --show-error --max-time 10 https://admin.potapoff.fun/api/health >/dev/null
    log "HTTPS smoke OK"
  else
    log "HTTPS smoke skipped (nginx/certificate not available to this shell)"
  fi
}

deploy() {
  preflight
  backup_state

  docker network inspect potapoff-shared >/dev/null 2>&1 || docker network create potapoff-shared >/dev/null
  log "building immutable runtime images"
  "${COMPOSE[@]}" build --pull admin intelligence-worker

  log "starting shared admin PostgreSQL first"
  "${COMPOSE[@]}" up -d admin-postgres
  wait_healthy potapoff-admin-postgres 120

  verify_sources
  migrate_admin_state

  log "capturing PostgreSQL backup after migration"
  local backup_dir
  backup_dir="$(cat "$BACKUP_ROOT/LATEST")"
  "${COMPOSE[@]}" exec -T admin-postgres pg_dump -U potapoff_admin -d potapoff_admin -Fc > "$backup_dir/admin-state-post-migration.dump"
  chmod 0600 "$backup_dir/admin-state-post-migration.dump" || true

  if grep -Eq '^POTAPOFF_INTELLIGENCE_BACKEND=postgres[[:space:]]*$' "$ADMIN_DIR/.env.intelligence"; then
    log "initializing PostgreSQL intelligence schema"
    "${COMPOSE[@]}" run --rm intelligence-worker python -m intelligence init-db
  fi

  log "cutting over admin and intelligence containers"
  "${COMPOSE[@]}" up -d admin intelligence-worker
  wait_healthy potapoff-admin 180
  wait_healthy potapoff-intelligence 180
  smoke
  log "DEPLOY_OK backup=$backup_dir"
}

case "$MODE" in
  preflight) preflight ;;
  deploy) deploy ;;
  smoke) smoke ;;
  *) die "usage: $0 {preflight|deploy|smoke}" ;;
esac
