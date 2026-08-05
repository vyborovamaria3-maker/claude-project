#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/potapoff-deploy}"
BACKUP_ROOT="${BACKUP_ROOT:-$DEPLOY_DIR/backups}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$STAMP"

mkdir -p "$DEST"
chmod 700 "$DEST"

cp -a "$DEPLOY_DIR/.env.server" "$DEST/" 2>/dev/null || true
cp -a "$DEPLOY_DIR/backend.env" "$DEST/" 2>/dev/null || true
cp -a "$DEPLOY_DIR/docker-compose.production.yml" "$DEST/" 2>/dev/null || true
cp -a "$DEPLOY_DIR/.current-image-tag" "$DEST/" 2>/dev/null || true

POSTGRES_CONTAINER="$(
  docker ps \
    --filter label=com.docker.compose.project=potapoff \
    --filter label=com.docker.compose.service=postgres \
    --format '{{.Names}}' | head -n1
)"

if [[ -z "$POSTGRES_CONTAINER" ]]; then
  echo "PostgreSQL container was not found" >&2
  exit 1
fi

docker exec "$POSTGRES_CONTAINER" \
  pg_dump -U potapoff -d potapoff -Fc \
  > "$DEST/postgres.dump"

test -s "$DEST/postgres.dump"
sha256sum "$DEST/postgres.dump" > "$DEST/SHA256SUMS"

find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +

echo "$DEST"
