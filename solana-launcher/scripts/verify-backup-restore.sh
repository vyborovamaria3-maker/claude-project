#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Independent, NONDESTRUCTIVE restore rehearsal. Never connects to a live DB.
# Only writes into two brand-new databases inside a temporary Docker container
# with NO network, published ports or persistent volumes.
if [[ "$#" -ne 1 || ! -d "$1" ]]; then
  echo "Usage: verify-backup-restore.sh /path/to/backup-directory" >&2
  exit 2
fi
command -v docker >/dev/null
command -v sha256sum >/dev/null
backup="$(cd -- "$1" && pwd -P)"
for file in SHA256SUMS postgres.dump admin-postgres.dump; do
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
for i in $(seq 1 45); do
  if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then
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
