#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

DEPLOY_DIR="${DEPLOY_DIR:-/opt/potapoff-deploy}"
BACKUP_ROOT="${BACKUP_ROOT:-$DEPLOY_DIR/backups}"
ADMIN_DIR="${ADMIN_DIR:-/opt/claude-project/admin-site}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
FINAL_DEST="$BACKUP_ROOT/$STAMP"
FRONTEND_CONTAINER=""
SQLITE_CONTAINER_TMP=""
INTELLIGENCE_CONTAINER=""
INTELLIGENCE_SQLITE_CONTAINER_TMP=""

install -d -m 0700 "$BACKUP_ROOT"
chmod 0700 "$BACKUP_ROOT"
# Never expose a partial backup under a successful timestamp. A failed dump
# must not age out verified backups or leave plaintext secrets behind.
[[ ! -e "$FINAL_DEST" ]] || { echo "Backup timestamp already exists" >&2; exit 1; }
DEST="$(mktemp -d "$BACKUP_ROOT/.incomplete-$STAMP.XXXXXX")"
cleanup(){
  if [[ -n "${SQLITE_CONTAINER_TMP:-}" && -n "${FRONTEND_CONTAINER:-}" ]]; then
    docker exec "$FRONTEND_CONTAINER" rm -f "$SQLITE_CONTAINER_TMP" >/dev/null 2>&1 || true
  fi
  if [[ -n "${INTELLIGENCE_SQLITE_CONTAINER_TMP:-}" && -n "${INTELLIGENCE_CONTAINER:-}" ]]; then
    docker exec "$INTELLIGENCE_CONTAINER" rm -f "$INTELLIGENCE_SQLITE_CONTAINER_TMP" >/dev/null 2>&1 || true
  fi
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

mapfile -t POSTGRES_CONTAINERS < <(
  docker ps \
    --filter label=com.docker.compose.project=potapoff \
    --filter label=com.docker.compose.service=postgres \
    --format '{{.Names}}'
)
if [[ "${#POSTGRES_CONTAINERS[@]}" -ne 1 ]]; then
  echo "Expected exactly one running POTAPoff PostgreSQL container" >&2
  exit 1
fi
POSTGRES_CONTAINER="${POSTGRES_CONTAINERS[0]}"

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

# trade.db is mounted into the frontend container at /app/data/trade.db.
# Use better-sqlite3's Online Backup API inside that container: a plain cp of
# trade.db can omit committed pages still present in the WAL file.
mapfile -t FRONTEND_CONTAINERS < <(
  docker ps \
    --filter label=com.docker.compose.project=potapoff \
    --filter label=com.docker.compose.service=frontend \
    --format '{{.Names}}'
)
if [[ "${#FRONTEND_CONTAINERS[@]}" -ne 1 ]]; then
  echo "Expected exactly one running frontend container for the SQLite database" >&2
  exit 1
fi
FRONTEND_CONTAINER="${FRONTEND_CONTAINERS[0]}"
SQLITE_CONTAINER_TMP="/tmp/potapoff-trade-$STAMP-$$.db"

docker exec -i \
  -e "POTAPOFF_TRADE_DB_SOURCE=${TRADE_DB_CONTAINER_PATH:-/app/data/trade.db}" \
  -e "POTAPOFF_TRADE_DB_BACKUP=$SQLITE_CONTAINER_TMP" \
  "$FRONTEND_CONTAINER" node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const sourcePath = process.env.POTAPOFF_TRADE_DB_SOURCE;
const backupPath = process.env.POTAPOFF_TRADE_DB_BACKUP;

(async () => {
  if (!sourcePath || !path.isAbsolute(sourcePath) ||
      !backupPath || !path.isAbsolute(backupPath) ||
      fs.existsSync(backupPath)) {
    throw new Error("invalid_sqlite_backup_paths");
  }

  let source;
  try {
    source = new Database(sourcePath, {
      readonly: true,
      fileMustExist: true,
      timeout: 10000,
    });
    if (source.pragma("quick_check", { simple: true }) !== "ok") {
      throw new Error("sqlite_source_quick_check_failed");
    }
    await source.backup(backupPath);
  } finally {
    if (source) source.close();
  }

  const snapshot = new Database(backupPath, {
    readonly: true,
    fileMustExist: true,
    timeout: 10000,
  });
  try {
    if (snapshot.pragma("integrity_check", { simple: true }) !== "ok") {
      throw new Error("sqlite_backup_integrity_check_failed");
    }
    const tables = snapshot.prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).get().n;
    const stat = fs.statSync(backupPath);
    if (!Number.isSafeInteger(tables) || tables < 1 || !stat.isFile() || stat.size <= 0) {
      throw new Error("sqlite_backup_is_empty");
    }
    fs.chmodSync(backupPath, 0o600);
    console.error("SQLITE_BACKUP_OK tables=" + tables + " bytes=" + stat.size);
  } finally {
    snapshot.close();
  }
})().catch(() => {
  console.error("SQLite backup failed validation");
  process.exitCode = 1;
});
NODE

docker cp "$FRONTEND_CONTAINER:$SQLITE_CONTAINER_TMP" "$DEST/trade.db"
test -s "$DEST/trade.db"
chmod 0600 "$DEST/trade.db"
docker exec "$FRONTEND_CONTAINER" rm -f "$SQLITE_CONTAINER_TMP"
SQLITE_CONTAINER_TMP=""

# The Python Intelligence worker owns a separate SQLite file in the named
# intelligence-state volume. Use SQLite's online backup API inside the owner
# container so committed WAL pages are included; never cp the live DB file.
INTELLIGENCE_CONTAINER="$(
  docker ps --filter 'name=^/potapoff-intelligence$' --format '{{.Names}}' | head -n1
)"
[[ -n "$INTELLIGENCE_CONTAINER" ]] || {
  echo "Python Intelligence worker container was not found" >&2
  exit 1
}
INTELLIGENCE_SQLITE_CONTAINER_TMP="/tmp/potapoff-intelligence-backup-${STAMP}-${BASHPID}.sqlite"
docker exec -e "POTAPOFF_INTELLIGENCE_BACKUP=$INTELLIGENCE_SQLITE_CONTAINER_TMP" \
  "$INTELLIGENCE_CONTAINER" python -c '
import os, sqlite3, sys
source = None
target = None
target_path = os.environ["POTAPOFF_INTELLIGENCE_BACKUP"]
try:
    source = sqlite3.connect("file:/var/lib/potapoff-intelligence/intelligence.sqlite3?mode=ro", uri=True)
    target = sqlite3.connect(target_path)
    source.backup(target)
    if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise RuntimeError("SQLite online backup integrity check failed")
    tables = target.execute(
        "SELECT count(*) FROM sqlite_master WHERE type=char(116,97,98,108,101)"
    ).fetchone()[0]
    if tables < 1:
        raise RuntimeError("Python Intelligence SQLite backup contains no tables")
    target.close()
    target = None
    source.close()
    source = None
    with open(target_path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            sys.stdout.buffer.write(chunk)
finally:
    if target is not None:
        target.close()
    if source is not None:
        source.close()
    try:
        os.remove(target_path)
    except FileNotFoundError:
        pass
' > "$DEST/intelligence.sqlite"
test -s "$DEST/intelligence.sqlite"

# Do not publish symlinks: they can point outside the recovery set and would
# not be covered by the regular-file SHA256 manifest.
if find "$DEST" -type l -print -quit | grep -q .; then
  echo "Backup contains a symlink; refusing to publish an incomplete recovery set" >&2
  exit 1
fi

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
