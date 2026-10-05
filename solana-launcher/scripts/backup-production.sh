#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/potapoff-deploy}"
BACKUP_ROOT="${BACKUP_ROOT:-$DEPLOY_DIR/backups}"
ADMIN_DIR="${ADMIN_DIR:-/opt/claude-project/admin-site}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$STAMP"

mkdir -p "$DEST"
chmod 700 "$DEST"

cp -a "$DEPLOY_DIR/.env.server" "$DEST/" 2>/dev/null || true
cp -a "$DEPLOY_DIR/backend.env" "$DEST/" 2>/dev/null || true
cp -a "$DEPLOY_DIR/docker-compose.production.yml" "$DEST/" 2>/dev/null || true
cp -a "$DEPLOY_DIR/.current-image-tag" "$DEST/" 2>/dev/null || true

# Keep the Control Center's server-only configuration with the same restrictive
# backup directory permissions. These files are excluded from GitHub release
# archives and are required to reconstruct the admin service after host loss.
mkdir -p "$DEST/admin-site"
for file in .env .env.intelligence sources.json logs.json; do
  if [[ -r "$ADMIN_DIR/$file" ]]; then
    cp -a "$ADMIN_DIR/$file" "$DEST/admin-site/$file"
  fi
done

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

ADMIN_POSTGRES_CONTAINER="$(
  docker ps \
    --filter 'name=^/potapoff-admin-postgres$' \
    --format '{{.Names}}' | head -n1
)"

if [[ -z "$ADMIN_POSTGRES_CONTAINER" ]]; then
  echo "Control Center PostgreSQL container was not found" >&2
  exit 1
fi

docker exec "$ADMIN_POSTGRES_CONTAINER" \
  pg_dump -U potapoff_admin -d potapoff_admin -Fc \
  > "$DEST/admin-postgres.dump"

test -s "$DEST/admin-postgres.dump"

# Hash the complete recovery set, not just the database dumps. Run from inside
# the backup directory so SHA256SUMS contains stable relative paths and never
# embeds the host's absolute deployment path.
(
  cd "$DEST"
  find . -type f ! -name SHA256SUMS -print0 \
    | sort -z \
    | xargs -0 sha256sum \
    > SHA256SUMS
  sha256sum -c SHA256SUMS >/dev/null
)

find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +

echo "$DEST"
