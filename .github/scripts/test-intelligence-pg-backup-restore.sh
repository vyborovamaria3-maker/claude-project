#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

: "${INTELLIGENCE_TEST_DB_URL:?INTELLIGENCE_TEST_DB_URL must point to a disposable CI PostgreSQL database}"
: "${PGHOST:?PGHOST is required}"
: "${PGPORT:?PGPORT is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"

restore_db="${INTELLIGENCE_RESTORE_DB_NAME:-intelligence_restore_ci}"
[[ "$restore_db" =~ ^[a-zA-Z][a-zA-Z0-9_]{0,62}$ ]] || {
  echo "Invalid disposable restore database name" >&2
  exit 2
}
restore_container="intelligence-pg-restore-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"

archive="$(mktemp)"
toc="${archive}.toc"
corrupt="${archive}.corrupt"
cleanup(){
  docker rm -f "$restore_container" >/dev/null 2>&1 || true
  psql "$INTELLIGENCE_TEST_DB_URL" -v ON_ERROR_STOP=1 -q \
    -c "DROP SCHEMA IF EXISTS backup_restore_probe CASCADE" >/dev/null 2>&1 || true
  rm -f -- "$archive" "$toc" "$corrupt"
}
trap cleanup EXIT

command -v psql >/dev/null
command -v pg_dump >/dev/null
command -v pg_restore >/dev/null
command -v docker >/dev/null

# A deterministic marker is written only to this disposable CI database.
psql "$INTELLIGENCE_TEST_DB_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DROP SCHEMA IF EXISTS backup_restore_probe CASCADE;
CREATE SCHEMA backup_restore_probe;
CREATE TABLE backup_restore_probe.recovery_marker (
  id INTEGER PRIMARY KEY,
  marker TEXT NOT NULL
);
INSERT INTO backup_restore_probe.recovery_marker(id,marker)
VALUES (1,'node-intelligence-ci-fixture');
SQL

pg_dump --dbname="$INTELLIGENCE_TEST_DB_URL" \
  --format=custom --no-owner --no-acl --file="$archive"
[[ -s "$archive" ]]
pg_restore --list "$archive" > "$toc"
[[ -s "$toc" ]]

# pg_dump may be newer than the PostgreSQL 16 source service. Restore into
# the matching PostgreSQL 17 disposable target so pg_restore never sends
# version-specific settings (for example transaction_timeout) to PG16.
docker run -d --rm --network none --name "$restore_container" \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine >/dev/null
ready=0
for i in $(seq 1 45); do
  if docker exec "$restore_container" pg_isready -U postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" = 1 ]] || { echo "Disposable PostgreSQL 17 restore target failed to start" >&2; exit 1; }
docker exec "$restore_container" createdb -U postgres "$restore_db"
docker exec -i "$restore_container" pg_restore -U postgres -d "$restore_db" \
  --no-owner --no-privileges --exit-on-error --single-transaction < "$archive"

restored="$(
  docker exec "$restore_container" psql -U postgres -d "$restore_db" -X -Atq \
    -v ON_ERROR_STOP=1 \
    -c "SELECT marker FROM backup_restore_probe.recovery_marker WHERE id=1"
)"
[[ "$restored" == "node-intelligence-ci-fixture" ]] || {
  echo "Restored PostgreSQL marker did not match the source snapshot" >&2
  exit 1
}

# The archive reader must reject a truncated custom-format archive.
head -c 64 "$archive" > "$corrupt"
if pg_restore --list "$corrupt" >/dev/null 2>&1; then
  echo "Truncated PostgreSQL archive was incorrectly accepted" >&2
  exit 1
fi

echo "INTELLIGENCE_PG_BACKUP_RESTORE_OK disposable_database=true marker_verified=true corrupt_archive_rejected=true"
