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
command -v cmp >/dev/null
command -v python3 >/dev/null
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROLE_FINGERPRINT_SQL="$SCRIPT_DIR/postgres-role-restoration-fingerprint.sql"
[[ -s "$ROLE_FINGERPRINT_SQL" ]] || {
  echo "Missing canonical role/ACL fingerprint query" >&2; exit 1;
}
backup="$(cd -- "$1" && pwd -P)"
unsupported_entry="$(find "$backup" ! -type f ! -type d -print -quit)"
if [[ -n "$unsupported_entry" ]]; then
  echo "Backup contains a symlink or unsupported non-regular entry; refusing restore verification" >&2
  exit 1
fi
for file in SHA256SUMS postgres.dump admin-postgres.dump trade.db intelligence.sqlite \
  postgres-roles.sql admin-postgres-roles.sql \
  postgres-role-fingerprint.txt admin-postgres-role-fingerprint.txt; do
  [[ -s "$backup/$file" && ! -L "$backup/$file" ]] || {
    echo "Backup missing required file or contains a symlink" >&2
    exit 1
  }
done
# A valid checksum for each listed file is insufficient: a truncated manifest
# can simply omit a changed .env or other recovery file. Recompute the exact
# canonical manifest from every regular file (including hidden/nested files),
# excluding only the root SHA256SUMS. Require byte-for-byte equality so that
# missing, extra, renamed, duplicated, altered or unlisted files fail closed.
(
  cd "$backup"
  expected_manifest="$(mktemp)"
  trap 'rm -f -- "$expected_manifest"' EXIT
  find . -type f ! -path './SHA256SUMS' -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum > "$expected_manifest"
  cmp -s SHA256SUMS "$expected_manifest" ||
    { echo "Backup SHA256 manifest is incomplete or mismatched" >&2; exit 1; }
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

with tempfile.TemporaryDirectory(prefix="potapoff-sqlite-source-") as source_directory:
    source_copy = pathlib.Path(source_directory) / "trade.db"
    shutil.copy2(source, source_copy)
    source_tables = inspect_readonly(source_copy)
    with tempfile.TemporaryDirectory(prefix="potapoff-sqlite-restore-") as directory:
        restored = pathlib.Path(directory) / "trade.db"
        shutil.copy2(source_copy, restored)
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
with tempfile.TemporaryDirectory(prefix="potapoff-intelligence-source-") as source_directory:
    source_copy = pathlib.Path(source_directory) / "intelligence.sqlite"
    shutil.copy2(source, source_copy)
    connection = sqlite3.connect(source_copy.as_uri() + "?mode=ro", uri=True)
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
        shutil.copy2(source_copy, restored)
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
acl_containers=()
acl_temp_files=()
cleanup(){
  docker rm -f "$container" "${acl_containers[@]}" >/dev/null 2>&1 || true
  for tmp in "${acl_temp_files[@]}"; do rm -f -- "$tmp"; done
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
  # The bootstrap server listens only on a Unix socket. Require the final
  # postmaster to answer over loopback TCP and execute a successful query.
  if docker logs "$container" 2>&1 | grep -Fq 'PostgreSQL init process complete; ready for start up.' &&
     docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d postgres >/dev/null 2>&1 &&
     docker exec "$container" psql -h 127.0.0.1 -U postgres -d postgres -X -Atq \
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
  docker exec "$container" createdb -h 127.0.0.1 -U postgres "$db" >/dev/null
  if ! docker exec -i "$container" pg_restore \
      --exit-on-error --single-transaction --no-owner --no-acl \
      -h 127.0.0.1 -U postgres -d "$db" \
      < "$backup/$source.dump" >/dev/null 2>&1; then
    echo "Disposable restore failed: $source" >&2
    exit 1
  fi
  tables="$(docker exec "$container" psql -h 127.0.0.1 -U postgres -d "$db" -X -Atq -v ON_ERROR_STOP=1 -c \
    "SELECT count(*) FROM pg_class WHERE relkind IN ('r','p') AND relnamespace NOT IN (SELECT oid FROM pg_namespace WHERE nspname LIKE 'pg_%' OR nspname='information_schema')")"
  if [[ ! "$tables" =~ ^[1-9][0-9]*$ ]]; then
    echo "Restored database has no application tables: $source" >&2
    exit 1
  fi
  # Semantic recovery gates: a dump containing only an unrelated table
  # must never pass as a restored POTAPoff/Admin database. This is checked
  # AFTER restore against the actual database, not just the pg_restore TOC.
  if [[ "$source" == postgres ]]; then
    ledger="$(docker exec "$container" psql -h 127.0.0.1 -U postgres \
      -d "$db" -X -Atq -v ON_ERROR_STOP=1 \
      -c "SELECT count(*) FROM public.alembic_version WHERE version_num <> ''")" || {
        echo "Product Alembic migration ledger is missing" >&2; exit 1;
      }
    [[ "$ledger" =~ ^[1-9][0-9]*$ ]] || {
      echo "Restored product Alembic ledger is empty" >&2; exit 1;
    }
  else
    schema_contract="$(docker exec "$container" psql -h 127.0.0.1 -U postgres \
      -d "$db" -X -Atq -v ON_ERROR_STOP=1 -c "
      SELECT count(*) FROM information_schema.columns
       WHERE table_schema='public' AND (
        (table_name='admin_audit' AND column_name IN ('id','action')) OR
        (table_name='feature_flags' AND column_name IN ('name','enabled')) OR
        (table_name='admin_background_tasks' AND column_name IN ('id','state')) OR
        (table_name='admin_security_sessions' AND column_name IN ('nonce','username'))
       )")"
    [[ "$schema_contract" == 8 ]] || {
      echo "Restored Admin database lacks critical application schema" >&2
      exit 1
    }
  fi
  echo "DISPOSABLE_PG_RESTORE_OK source=$source tables=$tables"
done
# Owner/ACL fidelity is a DIFFERENT gate from the data-only restore above.
# Replay password-free pg_dumpall globals in new disposable clusters matching
# each source major, then restore the original archives WITH database creation,
# owner and ACLs. --create is essential: pg_restore otherwise does not restore
# database-level CONNECT/CREATE/TEMPORARY ACLs or database owner/settings.
# Compare database ACL, role attributes/memberships, column/default ACLs and
# every scoped object owner/ACL to the read-only source fingerprint. These
# containers have no network, published ports, host mounts or persisted volumes.
for source in postgres admin-postgres; do
  if [[ "$source" == postgres ]]; then
    major=16
    restored_name=potapoff
  else
    major=17
    restored_name=potapoff_admin
  fi
  acl_container="potapoff-acl-restore-${major}-$-$RANDOM"
  # Register immediately: trap cleans up even on partial startup or restore.
  acl_containers+=("$acl_container")
  docker run -d --rm --network none --pids-limit 256 \
    --name "$acl_container" \
    -e "POSTGRES_USER=$restored_name" -e POSTGRES_DB=postgres \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    "postgres:${major}-alpine" >/dev/null
  ready=0
  for i in $(seq 1 60); do
    if docker logs "$acl_container" 2>&1 | grep -Fq 'PostgreSQL init process complete; ready for start up.' &&
       [[ "$(docker exec "$acl_container" psql -X -U "$restored_name" -d postgres -Atq \
         -v ON_ERROR_STOP=1 -c 'SELECT 1' 2>/dev/null)" == 1 ]]; then
      ready=1
      break
    fi
    sleep 1
  done
  [[ "$ready" == 1 ]] || {
    echo "Failed isolated role recovery target for $source" >&2; exit 1;
  }
  # Match the source bootstrap identity instead of inventing a postgres role:
  # every non-system role is part of the exact source fingerprint. initdb has
  # already created this one role; skip only its duplicate CREATE declaration.
  # Replay its ALTER attributes and all other roles/memberships unchanged.
  sed "/^CREATE ROLE ${restored_name};$/d" "$backup/$source-roles.sql" |
    docker exec -i "$acl_container" psql -X -U "$restored_name" -d postgres \
      -v ON_ERROR_STOP=1 >/dev/null
  docker exec -i "$acl_container" pg_restore -U "$restored_name" -d postgres \
    --create --exit-on-error \
    < "$backup/$source.dump" >/dev/null
  actual_catalog="$(mktemp)"
  acl_temp_files+=("$actual_catalog")
  docker exec -i "$acl_container" psql -X -A -t -U "$restored_name" \
    -d "$restored_name" -v ON_ERROR_STOP=1 \
    < "$ROLE_FINGERPRINT_SQL" > "$actual_catalog"
  cmp -s "$actual_catalog" "$backup/$source-role-fingerprint.txt" || {
    echo "Owner/ACL mismatch after isolated role-aware restore: $source" >&2
    exit 1
  }
  echo "DISPOSABLE_PG_ROLE_ACL_RESTORE_OK source=$source version=$major"
done
echo "BACKUP_ROLE_ACL_RESTORE_OK isolated=true"
echo "BACKUP_RESTORE_REHEARSAL_OK no_live_database_access=true"
