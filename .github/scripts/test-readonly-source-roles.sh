#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container="source-role-ci-${GITHUB_RUN_ID:-local}-$$"
bootstrap_password="ci-bootstrap-password"
app_password="ci-app-password"
migrator_password="ci-migrator-password"
readonly_password="ci-readonly-password"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$container" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD="$bootstrap_password" \
  -e POSTGRES_DB=postgres \
  postgres:16-alpine >/dev/null

ready=false
for _ in $(seq 1 60); do
  # The official postgres image starts a temporary Unix-socket-only server
  # during initdb. Require final init completion and a real TCP SQL round-trip.
  if docker logs "$container" 2>&1 | grep -Fq 'PostgreSQL init process complete; ready for start up.'; then
    if docker exec -e PGHOST=127.0.0.1 -e PGUSER=postgres -e PGPASSWORD="$bootstrap_password" "$container" \
      psql -X -v ON_ERROR_STOP=1 -d postgres -Atq -c 'SELECT 1' 2>/dev/null | grep -qx '1'; then
      ready=true
      break
    fi
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then docker logs "$container"; echo "Temporary PostgreSQL did not become ready" >&2; exit 1; fi

run_psql() {
  local database="$1" user="$2" password="$3"
  shift 3
  docker exec -e PGHOST=127.0.0.1 -e PGUSER="$user" -e PGPASSWORD="$password" "$container" \
    psql -X -v ON_ERROR_STOP=1 -d "$database" "$@"
}

test_role_set() {
  local database="$1" app_user="$2" migrator_user="$3" readonly_user="$4"
  local sql_path="$5" entrypoint_path="$6"

  run_psql postgres postgres "$bootstrap_password" -c "CREATE DATABASE $database" >/dev/null
  run_psql "$database" postgres "$bootstrap_password" -c \
    "CREATE TABLE source_probe (id integer PRIMARY KEY, value text); INSERT INTO source_probe VALUES (1, 'visible');" >/dev/null

  docker exec "$container" mkdir -p /provision
  docker cp "$repo_root/$sql_path" "$container:/provision/readonly-role.sql" >/dev/null
  docker cp "$repo_root/$entrypoint_path" "$container:/provision/run-readonly-role-provisioner.sh" >/dev/null

  # The role provisioner is deliberately idempotent.
  for _ in 1 2; do
    docker exec \
      -e PGHOST=127.0.0.1 \
      -e PGPORT=5432 \
      -e PGDATABASE="$database" \
      -e PGUSER=postgres \
      -e PGPASSWORD="$bootstrap_password" \
      -e POSTGRES_APP_USER="$app_user" \
      -e POSTGRES_APP_PASSWORD="$app_password" \
      -e POSTGRES_MIGRATOR_USER="$migrator_user" \
      -e POSTGRES_MIGRATOR_PASSWORD="$migrator_password" \
      -e POSTGRES_READONLY_USER="$readonly_user" \
      -e POSTGRES_READONLY_PASSWORD="$readonly_password" \
      "$container" /bin/sh /provision/run-readonly-role-provisioner.sh >/dev/null
  done

  # The shell entrypoint must fail closed if invoked with any restricted login.
  if docker exec \
    -e PGHOST=127.0.0.1 -e PGDATABASE="$database" \
    -e PGUSER="$app_user" -e PGPASSWORD="$app_password" \
    -e POSTGRES_APP_USER="$app_user" -e POSTGRES_APP_PASSWORD="$app_password" \
    -e POSTGRES_MIGRATOR_USER="$migrator_user" -e POSTGRES_MIGRATOR_PASSWORD="$migrator_password" \
    -e POSTGRES_READONLY_USER="$readonly_user" -e POSTGRES_READONLY_PASSWORD="$readonly_password" \
    "$container" /bin/sh /provision/run-readonly-role-provisioner.sh >/dev/null 2>&1; then
    echo "$app_user unexpectedly ran the privileged role provisioner" >&2
    return 1
  fi

  # Runtime has DML on existing objects but no schema/role administration.
  [[ "$(run_psql "$database" "$app_user" "$app_password" -Atq -c "SELECT value FROM source_probe WHERE id=1")" == "visible" ]]
  run_psql "$database" "$app_user" "$app_password" -c \
    "INSERT INTO source_probe VALUES (2,'runtime'); UPDATE source_probe SET value='updated' WHERE id=2; DELETE FROM source_probe WHERE id=2" >/dev/null
  if run_psql "$database" "$app_user" "$app_password" -c "CREATE TABLE runtime_must_not_ddl(id integer)" >/dev/null 2>&1; then
    echo "$app_user unexpectedly created a table" >&2
    return 1
  fi

  # Only the migration identity can create/alter schema objects. Default
  # privileges must grant runtime DML and read-only SELECT on new objects.
  run_psql "$database" "$migrator_user" "$migrator_password" -c \
    "CREATE TABLE migration_probe(id integer PRIMARY KEY, value text); INSERT INTO migration_probe VALUES (1,'migration'); ALTER TABLE migration_probe ADD COLUMN note text" >/dev/null
  run_psql "$database" "$app_user" "$app_password" -c \
    "INSERT INTO migration_probe(id,value) VALUES (2,'runtime'); UPDATE migration_probe SET note='ok' WHERE id=2; DELETE FROM migration_probe WHERE id=2" >/dev/null
  [[ "$(run_psql "$database" "$readonly_user" "$readonly_password" -Atq -c "SELECT value FROM migration_probe WHERE id=1")" == "migration" ]]

  for role in "$app_user" "$migrator_user" "$readonly_user"; do
    local flags memberships
    flags="$(run_psql "$database" postgres "$bootstrap_password" -Atq -c \
      "SELECT rolsuper::text || '|' || rolcreatedb::text || '|' || rolcreaterole::text || '|' || rolreplication::text || '|' || rolbypassrls::text || '|' || rolinherit::text FROM pg_roles WHERE rolname='$role'")"
    [[ "$flags" == "false|false|false|false|false|false" ]] || {
      echo "$role has unsafe role attributes: $flags" >&2
      return 1
    }
    memberships="$(run_psql "$database" postgres "$bootstrap_password" -Atq -c \
      "SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='$role'")"
    [[ "$memberships" == "0" ]] || {
      echo "$role still has role memberships: $memberships" >&2
      return 1
    }
    local role_password
    case "$role" in
      "$app_user") role_password="$app_password" ;;
      "$migrator_user") role_password="$migrator_password" ;;
      *) role_password="$readonly_password" ;;
    esac
    if run_psql "$database" "$role" "$role_password" -c "SET ROLE postgres" >/dev/null 2>&1; then
      echo "$role unexpectedly escalated to bootstrap" >&2
      return 1
    fi
  done

  [[ "$(run_psql "$database" "$readonly_user" "$readonly_password" -Atq -c "SHOW default_transaction_read_only")" == "on" ]]
  local readonly_writes
  readonly_writes="$(run_psql "$database" postgres "$bootstrap_password" -Atq -c \
    "SELECT has_table_privilege('$readonly_user','source_probe','INSERT')::text || '|' || has_table_privilege('$readonly_user','source_probe','UPDATE')::text || '|' || has_table_privilege('$readonly_user','source_probe','DELETE')::text || '|' || has_table_privilege('$readonly_user','source_probe','TRUNCATE')::text || '|' || has_table_privilege('$readonly_user','migration_probe','INSERT')::text || '|' || has_table_privilege('$readonly_user','migration_probe','UPDATE')::text || '|' || has_table_privilege('$readonly_user','migration_probe','DELETE')::text || '|' || has_table_privilege('$readonly_user','migration_probe','TRUNCATE')::text")"
  [[ "$readonly_writes" == "false|false|false|false|false|false|false|false" ]] || {
    echo "$readonly_user has write privileges: $readonly_writes" >&2
    return 1
  }
  if run_psql "$database" "$readonly_user" "$readonly_password" -c \
    "INSERT INTO source_probe VALUES (3,'must-not-write')" >/dev/null 2>&1; then
    echo "$readonly_user unexpectedly wrote to a source table" >&2
    return 1
  fi
}

test_role_set "solsub_role_ci" "solsub_app" "solsub_migrator" "solsub_readonly" \
  "solana-subscription-service/scripts/provision-readonly-role.sql" \
  "solana-subscription-service/scripts/run-readonly-role-provisioner.sh"
test_role_set "memecoin_role_ci" "memecoin_app" "memecoin_migrator" "memecoin_readonly" \
  "memecoin-intelligence/scripts/provision-readonly-role.sql" \
  "memecoin-intelligence/scripts/run-readonly-role-provisioner.sh"

echo "Application, migration and read-only roles are separated, least-privileged, idempotent and non-escalatable."
