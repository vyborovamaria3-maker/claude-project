#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Independent, NONDESTRUCTIVE restore rehearsal. Never connects to a live DB.
# PostgreSQL restores run in a temporary Docker container with NO network,
# published ports or persistent volumes. SQLite is copied to a temporary
# directory and opened independently; no application database is modified.
if [[ "$#" -ne 1 || ! -d "$1" ]]; then
  echo "Usage: verify-backup-restore.sh /path/to/backup-directory" >&2
  exit 2
fi
command -v docker >/dev/null
command -v sha256sum >/dev/null
command -v python3 >/dev/null
backup="$(cd -- "$1" && pwd -P)"
if find "$backup" -type l -print -quit | grep -q .; then
  echo "Backup contains a symlink; refusing restore verification" >&2
  exit 1
fi
for file in SHA256SUMS postgres.dump admin-postgres.dump trade.db intelligence.sqlite; do
  [[ -s "$backup/$file" && ! -L "$backup/$file" ]] || {
    echo "Backup missing required file or contains a symlink" >&2
    exit 1
  }
done
(
  cd "$backup"
  sha256sum --strict --check SHA256SUMS >/dev/null ||
    { echo "Backup SHA256 manifest mismatch" >&2; exit 1; }
)
echo "BACKUP_MANIFEST_VERIFIED"

# Verify and restore the SQLite snapshot into a fresh temporary path. The
# backup itself is never opened for writes; the restored copy must pass a full
# integrity check and contain application tables.
python3 - "$backup/trade.db" <<'PY'
import pathlib
import shutil
import sqlite3
import sys
import tempfile

source = pathlib.Path(sys.argv[1]).resolve()

def inspect_readonly(path):
    uri = path.resolve().as_uri() + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    try:
        integrity = connection.execute("PRAGMA integrity_check").fetchall()
        if integrity != [("ok",)]:
            raise RuntimeError("SQLite integrity check failed")
        tables = connection.execute(
            "SELECT count(*) FROM sqlite_master "
            "WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchone()[0]
        if not isinstance(tables, int) or tables < 1:
            raise RuntimeError("SQLite snapshot has no application tables")
        return tables
    finally:
        connection.close()

source_tables = inspect_readonly(source)
with tempfile.TemporaryDirectory(prefix="potapoff-sqlite-restore-") as directory:
    restored = pathlib.Path(directory) / "trade.db"
    shutil.copy2(source, restored)
    connection = sqlite3.connect(str(restored))
    try:
        integrity = connection.execute("PRAGMA integrity_check").fetchall()
        if integrity != [("ok",)]:
            raise RuntimeError("Restored SQLite copy failed integrity check")
        restored_tables = connection.execute(
            "SELECT count(*) FROM sqlite_master "
            "WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchone()[0]
        if restored_tables != source_tables:
            raise RuntimeError("Restored SQLite table count differs")
    finally:
        connection.close()

print(f"DISPOSABLE_SQLITE_RESTORE_OK tables={source_tables}")
PY

# Independently restore the Python Intelligence SQLite snapshot as well.
python3 - "$backup/intelligence.sqlite" <<'PY'
import pathlib
import shutil
import sqlite3
import sys
import tempfile

source = pathlib.Path(sys.argv[1]).resolve()
connection = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
try:
    if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise RuntimeError("Python Intelligence SQLite snapshot failed integrity check")
    tables = connection.execute(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchone()[0]
    if not isinstance(tables, int) or tables < 1:
        raise RuntimeError("Python Intelligence SQLite snapshot has no application tables")
finally:
    connection.close()

with tempfile.TemporaryDirectory(prefix="potapoff-intelligence-restore-") as directory:
    restored = pathlib.Path(directory) / "intelligence.sqlite"
    shutil.copy2(source, restored)
    db = sqlite3.connect(str(restored))
    try:
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise RuntimeError("Restored Python Intelligence SQLite copy failed integrity check")
        restored_tables = db.execute(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchone()[0]
        if restored_tables != tables:
            raise RuntimeError("Restored Python Intelligence table count differs")
    finally:
        db.close()
print(f"DISPOSABLE_INTELLIGENCE_SQLITE_RESTORE_OK tables={tables}")
PY

container="potapoff-restore-test-$$-$RANDOM"
cleanup(){
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# No network and no host bind mounts: this CANNOT target a production database.
# Trust authentication is safe only inside this disposable isolated container,
# without any published ports or network interfaces.
docker run -d --rm --name "$container" \
  --network none --pids-limit 256 \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  postgres:17-alpine >/dev/null
ready=0
for i in $(seq 1 60); do
  # Ignore PostgreSQL's temporary bootstrap server. After the entrypoint
  # completes initdb, require both pg_isready and a successful SQL round-trip.
  if docker logs "$container" 2>&1 | grep -Fq 'PostgreSQL init process complete; ready for start up.' &&
     docker exec "$container" pg_isready -h /var/run/postgresql -U postgres >/dev/null 2>&1 &&
     docker exec "$container" psql -h /var/run/postgresql -U postgres -d postgres -X -Atq \
       -v ON_ERROR_STOP=1 -c 'SELECT 1' 2>/dev/null | grep -qx '1'; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  echo "Disposable database failed to initialize" >&2
  exit 1
fi
for source in postgres admin-postgres; do
  if [[ "$source" == "postgres" ]]; then
    db="isolated_product"
  else
    db="isolated_admin"
  fi
  if ! docker exec -i "$container" pg_restore --list \
    < "$backup/$source.dump" >/dev/null 2>&1; then
    echo "Invalid custom-format PostgreSQL dump: $source" >&2
    exit 1
  fi
  docker exec "$container" createdb -U postgres "$db" >/dev/null
  if ! docker exec -i "$container" pg_restore \
      --exit-on-error --no-owner --no-acl \
      -U postgres -d "$db" \
      < "$backup/$source.dump" >/dev/null 2>&1; then
    echo "Disposable restore failed: $source" >&2
    exit 1
  fi
  tables="$(docker exec "$container" psql -U postgres -d "$db" -Atc \
    "SELECT count(*) FROM pg_class WHERE relkind IN ('r','p') AND relnamespace NOT IN (SELECT oid FROM pg_namespace WHERE nspname LIKE 'pg_%' OR nspname='information_schema')")"
  if [[ ! "$tables" =~ ^[1-9][0-9]*$ ]]; then
    echo "Restored database has no application tables: $source" >&2
    exit 1
  fi
  echo "DISPOSABLE_PG_RESTORE_OK source=$source tables=$tables"
done
echo "BACKUP_RESTORE_REHEARSAL_OK no_live_database_access=true"
