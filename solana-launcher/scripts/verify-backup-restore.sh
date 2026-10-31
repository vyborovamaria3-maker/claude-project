#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Independent, NONDESTRUCTIVE restore rehearsal. Never connects to a live DB.
# Restores two PostgreSQL dumps into brand-new databases inside a temporary
# container, then verifies SQLite in a separate temporary container. Neither
# container has network access or persistent volumes.
if [[ "$#" -ne 1 || ! -d "$1" ]]; then
  echo "Usage: verify-backup-restore.sh /path/to/backup-directory" >&2
  exit 2
fi
command -v docker >/dev/null
command -v sha256sum >/dev/null
backup="$(cd -- "$1" && pwd -P)"
for file in SHA256SUMS postgres.dump admin-postgres.dump intelligence.sqlite; do
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

container="potapoff-restore-test-$-$RANDOM"
sqlite_scratch="$(mktemp -d)"
cp -- "$backup/intelligence.sqlite" "$sqlite_scratch/intelligence.sqlite"
chmod 0400 "$sqlite_scratch/intelligence.sqlite"
cleanup(){
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf -- "$sqlite_scratch"
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
for i in $(seq 1 45); do
  # Ignore PostgreSQL's temporary bootstrap server, which accepts requests
  # before the entrypoint stops and restarts the final postmaster.
  if docker logs "$container" 2>&1 | grep -Fq 'PostgreSQL init process complete; ready for start up.' &&
     docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then
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

# The Python Intelligence SQLite file is restored through SQLite's online
# backup API into a temporary container-local file. The source archive is
# mounted read-only; no named volume, host path or live database is modified.
docker run --rm --network none --read-only --pids-limit 64 \
  --tmpfs /tmp:size=64m,mode=1777 \
  --mount "type=bind,src=$sqlite_scratch,dst=/backup,readonly" \
  python:3.12-alpine python -c '
import sqlite3
source = sqlite3.connect("file:/backup/intelligence.sqlite?mode=ro", uri=True)
target = sqlite3.connect("/tmp/intelligence-restored.sqlite")
try:
    source.backup(target)
    integrity = target.execute("PRAGMA integrity_check").fetchone()[0]
    tables = target.execute(
        "SELECT count(*) FROM sqlite_master WHERE type=\x27table\x27"
    ).fetchone()[0]
    if integrity != "ok" or tables < 1:
        raise SystemExit("SQLite restore verification failed")
    print("DISPOSABLE_SQLITE_RESTORE_OK tables=" + str(tables))
finally:
    target.close()
    source.close()
'

echo "BACKUP_RESTORE_REHEARSAL_OK no_live_database_access=true"
