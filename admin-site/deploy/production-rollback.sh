#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd -- "$ADMIN_DIR/.." && pwd)"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/potapoff-admin}"
DEPLOYED_SHA_FILE="${DEPLOYED_SHA_FILE:-$BACKUP_ROOT/DEPLOYED_GIT_SHA}"
BACKUP_DIR="${1:-}"
COMPOSE=(docker compose --project-directory "$ADMIN_DIR" -f "$ADMIN_DIR/docker-compose.yml")
source "$SCRIPT_DIR/deployed-sha.sh"

log() { printf '[rollback] %s\n' "$*"; }
die() { printf '[rollback] ERROR: %s\n' "$*" >&2; exit 1; }

if [[ -z "$BACKUP_DIR" ]]; then
  [[ -f "$BACKUP_ROOT/LATEST" ]] || die "pass a backup directory or create $BACKUP_ROOT/LATEST"
  BACKUP_DIR="$(cat "$BACKUP_ROOT/LATEST")"
fi
[[ -d "$BACKUP_DIR" ]] || die "backup directory not found: $BACKUP_DIR"
[[ -f "$BACKUP_DIR/git-sha.txt" ]] || die "backup is missing the previously deployed git-sha.txt; this backup has no verified rollback target"
[[ -f "$BACKUP_DIR/target-git-sha.txt" ]] || die "backup is missing target-git-sha.txt; refusing ambiguous legacy rollback metadata"

PREVIOUS_SHA="$(tr -d '[:space:]' < "$BACKUP_DIR/git-sha.txt")"
TARGET_SHA="$(tr -d '[:space:]' < "$BACKUP_DIR/target-git-sha.txt")"
[[ "$PREVIOUS_SHA" =~ ^[0-9a-fA-F]{40}$ ]] || die "invalid previous git SHA"
[[ "$TARGET_SHA" =~ ^[0-9a-fA-F]{40}$ ]] || die "invalid target git SHA"
[[ "$PREVIOUS_SHA" != "$TARGET_SHA" ]] || die "rollback target equals the deployment being rolled out"

if [[ -e "$DEPLOYED_SHA_FILE" ]]; then
  [[ -r "$DEPLOYED_SHA_FILE" ]] || die "deployed SHA marker is not readable"
  CURRENT_DEPLOYED_SHA="$(tr -d '[:space:]' < "$DEPLOYED_SHA_FILE")"
  [[ "$CURRENT_DEPLOYED_SHA" =~ ^[0-9a-fA-F]{40}$ ]] || die "deployed SHA marker is invalid"
  [[ "$CURRENT_DEPLOYED_SHA" == "$TARGET_SHA" || "$CURRENT_DEPLOYED_SHA" == "$PREVIOUS_SHA" ]] || die "backup does not match the currently recorded deployment"
else
  log "deployed SHA marker is absent; relying on the explicit previous/target SHA pair in this backup"
fi

log "rolling application code back to $PREVIOUS_SHA"
git -C "$REPO_DIR" fetch --all --prune
git -C "$REPO_DIR" cat-file -e "$PREVIOUS_SHA^{commit}" 2>/dev/null || die "previous commit is not available locally/remotely"
git -C "$REPO_DIR" checkout --detach "$PREVIOUS_SHA"

# Restore deployment configuration snapshots only when explicitly requested.
# Normally .env/sources/logs were not modified by production-deploy.sh, so leaving
# them untouched is safer. Set RESTORE_CONFIG=1 only if the operator changed them.
if [[ "${RESTORE_CONFIG:-0}" == "1" ]]; then
  for file in .env .env.runtime .env.intelligence sources.json logs.json; do
    if [[ -f "$BACKUP_DIR/$file" ]]; then
      cp -a "$BACKUP_DIR/$file" "$ADMIN_DIR/$file"
      chmod 0600 "$ADMIN_DIR/$file" 2>/dev/null || true
    fi
  done
fi

if [[ -r "$SCRIPT_DIR/refresh-runtime-env.sh" ]]; then
  bash "$SCRIPT_DIR/refresh-runtime-env.sh"
elif grep -q '\.env\.runtime' "$ADMIN_DIR/docker-compose.yml" && [[ ! -f "$ADMIN_DIR/.env.runtime" ]]; then
  die "rollback target requires .env.runtime but neither an allowlist helper nor a saved runtime env is available"
fi

"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" build admin intelligence-worker
"${COMPOSE[@]}" up -d admin intelligence-worker

# Wait for the admin endpoint instead of sleeping blindly.
for _ in $(seq 1 60); do
  if curl --fail --silent --max-time 3 http://127.0.0.1:18080/api/health >/dev/null 2>&1; then
    log "admin health recovered"
    break
  fi
  sleep 2
done
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:18080/api/health >/dev/null || {
  "${COMPOSE[@]}" logs --tail=150 admin >&2 || true
  die "admin did not recover after rollback"
}

# The SQLite audit/state file was never deleted by the deploy; migration only read it.
# Only restore the copied SQLite file when explicitly requested after confirming the
# previous app actually uses SQLite mutable state.
if [[ "${RESTORE_SQLITE_STATE:-0}" == "1" && -f "$BACKUP_DIR/audit.db" ]]; then
  log "RESTORE_SQLITE_STATE=1 requested; restoring legacy audit.db"
  "${COMPOSE[@]}" stop admin
  docker cp "$BACKUP_DIR/audit.db" potapoff-admin:/var/lib/potapoff-admin/audit.db 2>/dev/null || die "could not restore audit.db into admin container"
  "${COMPOSE[@]}" start admin
fi

"${COMPOSE[@]}" ps
DEPLOYED_SHA="$(write_deployed_sha "$REPO_DIR" "$DEPLOYED_SHA_FILE")" || die "could not persist the rolled-back Git SHA"
log "recorded successfully deployed commit=$DEPLOYED_SHA"
log "ROLLBACK_OK previous_sha=$PREVIOUS_SHA backup=$BACKUP_DIR"
