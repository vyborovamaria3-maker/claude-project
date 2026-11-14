#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

DEPLOY_DIR="${DEPLOY_DIR:-/opt/potapoff-deploy}"
BACKUP_ROOT="${BACKUP_ROOT:-$DEPLOY_DIR/backups}"
ADMIN_DIR="${ADMIN_DIR:-/opt/claude-project/admin-site}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROLE_FINGERPRINT_SQL="$SCRIPT_DIR/postgres-role-restoration-fingerprint.sql"
[[ -s "$ROLE_FINGERPRINT_SQL" ]] || {
  echo "Missing role/ACL fingerprint SQL next to backup script" >&2; exit 1;
}
STAMP="$(date -u +%Y%m%d-%H%M%S)"
FINAL_DEST="$BACKUP_ROOT/$STAMP"
FRONTEND_CONTAINER=""
SQLITE_CONTAINER_TMP=""
INTELLIGENCE_CONTAINER=""
INTELLIGENCE_SQLITE_CONTAINER_TMP=""

# Keep database passwords out of docker's argv/process list. The password is
# read from stdin inside the container and exported only to the child process.
docker_exec_with_pgpassword() {
  local container="$1" password="$2"
  shift 2
  printf '%s\n' "$password" | docker exec -i "$container" sh -c '
    IFS= read -r PGPASSWORD || exit 1
    export PGPASSWORD
    exec "$@"
  ' sh "$@"
}

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

for file in .env.server .env.runtime backend.env docker-compose.production.yml; do
  [[ -r "$DEPLOY_DIR/$file" ]] || { echo "Missing required backup config: $file" >&2; exit 1; }
  cp -a "$DEPLOY_DIR/$file" "$DEST/"
done
cp -a "$ROLE_FINGERPRINT_SQL" "$DEST/"
cp -a "$DEPLOY_DIR/scripts/provision-postgres-roles.sql" "$DEST/"
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

POSTGRES_BACKUP_USER="$(sed -n 's/^POSTGRES_BACKUP_USER=//p' "$DEPLOY_DIR/.env.server" | tail -n 1)"
POSTGRES_BACKUP_PASSWORD="$(sed -n 's/^POSTGRES_BACKUP_PASSWORD=//p' "$DEPLOY_DIR/.env.server" | tail -n 1)"
if [[ ! "$POSTGRES_BACKUP_USER" =~ ^[a-z_][a-z0-9_]{0,62}$ || ! "$POSTGRES_BACKUP_PASSWORD" =~ ^[A-Fa-f0-9]{64}$ ]]; then
  echo "Dedicated PostgreSQL backup credentials are missing or invalid" >&2
  exit 1
fi

docker_exec_with_pgpassword "$POSTGRES_CONTAINER" "$POSTGRES_BACKUP_PASSWORD" \
  pg_dump -h 127.0.0.1 -U "$POSTGRES_BACKUP_USER" -d potapoff -Fc \
  > "$DEST/postgres.dump"

test -s "$DEST/postgres.dump"
# The custom archive retains database metadata; pg_restore --create in the
# role-aware rehearsal restores database owner, ACLs and database settings.
# CRC/TOC parse detects truncated archives.
docker exec -i "$POSTGRES_CONTAINER" pg_restore --list < "$DEST/postgres.dump" >/dev/null
# Preserve non-secret global role declarations and an exact catalog fingerprint
# for full owner/ACL restore in an offline, disconnected container.
docker exec "$POSTGRES_CONTAINER" pg_dumpall -U potapoff \
  --globals-only --no-role-passwords > "$DEST/postgres-roles.sql"
test -s "$DEST/postgres-roles.sql"
docker exec -i "$POSTGRES_CONTAINER" \
  psql -X -A -t -U potapoff -d potapoff -v ON_ERROR_STOP=1 \
  < "$ROLE_FINGERPRINT_SQL" > "$DEST/postgres-role-fingerprint.txt"
test -s "$DEST/postgres-role-fingerprint.txt"


ADMIN_POSTGRES_CONTAINER="$(
  docker ps \
    --filter 'name=^/potapoff-admin-postgres$' \
    --format '{{.Names}}' | head -n1
)"

if [[ -z "$ADMIN_POSTGRES_CONTAINER" ]]; then
  echo "Control Center PostgreSQL container was not found" >&2
  exit 1
fi

ADMIN_STATE_BACKUP_USER="$(sed -n 's/^ADMIN_STATE_BACKUP_USER=//p' "$ADMIN_DIR/.env" | tail -n 1)"
ADMIN_STATE_BACKUP_PASSWORD="$(sed -n 's/^ADMIN_STATE_BACKUP_PASSWORD=//p' "$ADMIN_DIR/.env" | tail -n 1)"
if [[ ! "$ADMIN_STATE_BACKUP_USER" =~ ^[a-z_][a-z0-9_]{0,62}$ || ! "$ADMIN_STATE_BACKUP_PASSWORD" =~ ^[A-Fa-f0-9]{64}$ ]]; then
  echo "Dedicated Control Center PostgreSQL backup credentials are missing or invalid" >&2
  exit 1
fi

# Data dumps use the dedicated read-only backup login over authenticated TCP.
# The bootstrap login is reserved below for global role metadata and catalog
# fingerprints, which require elevated catalog visibility.
docker_exec_with_pgpassword "$ADMIN_POSTGRES_CONTAINER" "$ADMIN_STATE_BACKUP_PASSWORD" \
  pg_dump -h 127.0.0.1 -U "$ADMIN_STATE_BACKUP_USER" -d potapoff_admin -Fc \
  > "$DEST/admin-postgres.dump"

test -s "$DEST/admin-postgres.dump"
docker exec -i "$ADMIN_POSTGRES_CONTAINER" pg_restore --list < "$DEST/admin-postgres.dump" >/dev/null
docker exec "$ADMIN_POSTGRES_CONTAINER" pg_dumpall -U potapoff_admin \
  --globals-only --no-role-passwords > "$DEST/admin-postgres-roles.sql"
test -s "$DEST/admin-postgres-roles.sql"
docker exec -i "$ADMIN_POSTGRES_CONTAINER" \
  psql -X -A -t -U potapoff_admin -d potapoff_admin -v ON_ERROR_STOP=1 \
  < "$ROLE_FINGERPRINT_SQL" > "$DEST/admin-postgres-role-fingerprint.txt"
test -s "$DEST/admin-postgres-role-fingerprint.txt"


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

// The temporary database may contain private wallet/analytics records.
process.umask(0o077);

const sourcePath = process.env.POTAPOFF_TRADE_DB_SOURCE;
const backupPath = process.env.POTAPOFF_TRADE_DB_BACKUP;

(async () => {
  if (!sourcePath || !path.isAbsolute(sourcePath) ||
      !backupPath || !path.isAbsolute(backupPath) ||
      fs.existsSync(backupPath)) {
    throw new Error("invalid_sqlite_backup_paths");
  }
  const sourceStat = fs.lstatSync(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("sqlite_source_must_be_regular_file");
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
os.umask(0o077)
source = None
target = None
target_path = os.environ["POTAPOFF_INTELLIGENCE_BACKUP"]
source_path = "/var/lib/potapoff-intelligence/intelligence.sqlite3"
try:
    if os.path.islink(source_path) or not os.path.isfile(source_path):
        raise RuntimeError("Python Intelligence source must be a regular file")
    source = sqlite3.connect("file:" + source_path + "?mode=ro", uri=True)
    if source.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
        raise RuntimeError("Python Intelligence source quick_check failed")
    target = sqlite3.connect(target_path)
    os.chmod(target_path, 0o600)
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
unsupported_entry="$(find "$DEST" ! -type f ! -type d -print -quit)"
if [[ -n "$unsupported_entry" ]]; then
  echo "Backup contains a symlink or unsupported non-regular entry; refusing publication" >&2
  exit 1
fi

# Hash the complete recovery set, not just the database dumps. Run from inside
# the backup directory so SHA256SUMS contains stable relative paths and never
# embeds the host's absolute deployment path.
(
  cd "$DEST"
  find . -type f ! -path './SHA256SUMS' -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum \
    > SHA256SUMS
  sha256sum -c SHA256SUMS >/dev/null
)

# A verified manifest and readable pg_restore TOC do not prove that data
# can be restored. Fail closed unless THIS exact recovery set survives the
# isolated offline PostgreSQL restore plus both SQLite integrity checks.
# The verifier runs with --network none, without bind-mounting live databases.
verifier="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/verify-backup-restore.sh"
[[ -r "$verifier" ]] || {
  echo "Missing isolated backup restore verifier" >&2
  exit 1
}
verification_log="$(mktemp)"
if ! bash "$verifier" "$DEST" > "$verification_log" 2>&1; then
  echo "Isolated backup restore verification failed; refusing publication" >&2
  # Report only fixed stage markers; raw PostgreSQL diagnostics/catalogs may
  # contain private deployment metadata and must never reach shared CI logs.
  grep -E '^(BACKUP_MANIFEST_VERIFIED|DISPOSABLE_SQLITE_RESTORE_OK tables=[0-9]+|DISPOSABLE_INTELLIGENCE_SQLITE_RESTORE_OK tables=[0-9]+|DISPOSABLE_PG_RESTORE_OK source=(postgres|admin-postgres) tables=[0-9]+|DISPOSABLE_PG_ROLE_ACL_RESTORE_OK source=(postgres|admin-postgres) version=(16|17)|Owner/ACL mismatch after isolated role-aware restore: (postgres|admin-postgres))$' \
    "$verification_log" >&2 || true
  rm -f -- "$verification_log"
  exit 1
fi
if ! grep -Fxq 'BACKUP_RESTORE_REHEARSAL_OK no_live_database_access=true' "$verification_log"; then
  echo "Restore verifier returned without the expected success evidence" >&2
  rm -f -- "$verification_log"
  exit 1
fi
rm -f -- "$verification_log"
echo "BACKUP_RESTORE_VERIFIED isolated=true" >&2

mv -T -- "$DEST" "$FINAL_DEST"
DEST="" # disarm failed-backup cleanup after verified atomic promotion
# Do NOT prune earlier backups by age. Off-host durable copy, operator-owned
# retention criteria and independently evidenced restore/RPO/RTO are not yet
# established; deleting an older recoverable set here could destroy the only
# usable recovery point. Retention remains a separately reviewed operation.

echo "$FINAL_DEST"
