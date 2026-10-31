#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

DEPLOY_DIR="${DEPLOY_DIR:-/opt/potapoff-deploy}"
BACKUP_ROOT="${BACKUP_ROOT:-$DEPLOY_DIR/backups}"
ADMIN_DIR="${ADMIN_DIR:-/opt/claude-project/admin-site}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
FINAL_DEST="$BACKUP_ROOT/$STAMP"

install -d -m 0700 "$BACKUP_ROOT"
chmod 0700 "$BACKUP_ROOT"
# Never expose a partial backup under a successful timestamp. A failed dump
# must not age out verified backups or leave plaintext secrets behind.
[[ ! -e "$FINAL_DEST" ]] || { echo "Backup timestamp already exists" >&2; exit 1; }
DEST="$(mktemp -d "$BACKUP_ROOT/.incomplete-$STAMP.XXXXXX")"
cleanup(){
  if [[ -n "$DEST" && -d "$DEST" ]]; then rm -rf -- "$DEST"; fi
}
trap cleanup EXIT

for file in .env.server backend.env docker-compose.production.yml; do
  [[ -r "$DEPLOY_DIR/$file" ]] || { echo "Missing required backup config: $file" >&2; exit 1; }
  cp -a "$DEPLOY_DIR/$file" "$DEST/"
done
if [[ -r "$DEPLOY_DIR/.current-image-tag" ]]; then
  cp -a "$DEPLOY_DIR/.current-image-tag" "$DEST/"
fi

# Keep the Control Center's server-only configuration with the same restrictive
# backup directory permissions. These files are excluded from GitHub release
# archives and are required to reconstruct the admin service after host loss.
mkdir -p "$DEST/admin-site"
[[ -r "$ADMIN_DIR/.env" ]] || { echo "Missing Control Center environment backup source" >&2; exit 1; }
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
# CRC/TOC parse detects truncated dump archives before declaring success.
docker exec -i "$POSTGRES_CONTAINER" pg_restore --list < "$DEST/postgres.dump" >/dev/null

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
docker exec -i "$ADMIN_POSTGRES_CONTAINER" pg_restore --list < "$DEST/admin-postgres.dump" >/dev/null

# The Python Intelligence worker owns a separate SQLite file in the named
# intelligence-state volume. Use SQLite's online backup API inside the owner
# container so committed WAL pages are included; never cp the live DB file.
INTELLIGENCE_CONTAINER="$(
  docker ps --filter 'name=^/potapoff-intelligence, not just the database dumps. Run from inside
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

mv -T -- "$DEST" "$FINAL_DEST"
DEST="" # disarm failed-backup cleanup after atomic promotion
# Prune only completed, verified timestamp directories. Never delete
# .incomplete-* while another backup could still be writing one.
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d \
  -name '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]' \
  -mtime +14 -exec rm -rf -- {} +

echo "$FINAL_DEST"
 --format '{{.Names}}' | head -n1
)"
[[ -n "$INTELLIGENCE_CONTAINER" ]] || {
  echo "Python Intelligence worker container was not found" >&2
  exit 1
}
docker exec "$INTELLIGENCE_CONTAINER" python -c '
import os, sqlite3, sys
source = sqlite3.connect("file:/var/lib/potapoff-intelligence/intelligence.sqlite3?mode=ro", uri=True)
target_path = "/tmp/potapoff-intelligence-backup.sqlite"
target = sqlite3.connect(target_path)
try:
    source.backup(target)
    if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise RuntimeError("SQLite online backup integrity check failed")
finally:
    target.close()
    source.close()
with open(target_path, "rb") as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        sys.stdout.buffer.write(chunk)
os.remove(target_path)
' > "$DEST/intelligence.sqlite"
test -s "$DEST/intelligence.sqlite"

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

mv -T -- "$DEST" "$FINAL_DEST"
DEST="" # disarm failed-backup cleanup after atomic promotion
# Prune only completed, verified timestamp directories. Never delete
# .incomplete-* while another backup could still be writing one.
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d \
  -name '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]' \
  -mtime +14 -exec rm -rf -- {} +

echo "$FINAL_DEST"
