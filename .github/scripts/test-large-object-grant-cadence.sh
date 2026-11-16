#!/usr/bin/env bash
# Synthetic, disconnected large-object export-grant cadence drill (issue #216,
# review finding F3). Proves that:
#   1. a migrator-owned large object created AFTER provisioning is invisible to
#      the backup identity before the grant step (reproduces the defect);
#   2. grant-large-objects.sql, run as the migrator owner (or a maintenance
#      role that is a member of it), makes the object exportable;
#   3. a pg_dump run under the backup identity INCLUDES the object and a
#      restore into a second disconnected container preserves its content
#      byte-for-byte;
#   4. the grant step is idempotent, also covers large objects created after
#      an earlier grant run, supports the single-grantee admin mode, and
#      fails closed on large objects owned outside the migrator identity;
#   5. the backup identity gains nothing beyond large-object SELECT.
# NO real cluster, service, persistent volume, password or network port is used.
set -euo pipefail

command -v docker >/dev/null
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
grant_sql="$root/solana-launcher/scripts/grant-large-objects.sql"
[[ -s "$grant_sql" ]] || { echo "Missing grant-large-objects.sql" >&2; exit 1; }

scratch="$(mktemp -d)"
tag="lo-cadence-${RANDOM}-$$"
containers=()
cleanup() {
  for name in "${containers[@]}"; do
    docker rm -f "$name" >/dev/null 2>&1 || true
  done
  rm -rf "$scratch"
}
trap cleanup EXIT

start_fixture() {
  local name="$1" version="$2" database="$3"
  containers+=("$name")
  docker run -d --rm --network none --name "$name" \
    -e POSTGRES_USER=fixture_bootstrap \
    -e POSTGRES_DB="$database" \
    -e POSTGRES_PASSWORD=fixture-bootstrap-ci-only \
    -e POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 \
    -e POSTGRES_HOST_AUTH_METHOD=scram-sha-256 \
    "postgres:${version}-alpine" >/dev/null
}

wait_final_postgres() {
  local name="$1" database="$2" ready=0
  for ((i=0; i<60; i++)); do
    # The entrypoint starts and stops a temporary Unix-socket-only server.
    # Require final init completion AND an actual TCP SQL round-trip.
    if docker logs "$name" 2>&1 | grep -Fq 'PostgreSQL init process complete; ready for start up.' &&
       [[ "$(docker exec -e PGPASSWORD=fixture-bootstrap-ci-only "$name" psql -X -h 127.0.0.1 \
         -U fixture_bootstrap -d "$database" -v ON_ERROR_STOP=1 \
         -Atq -c 'SELECT 1' 2>/dev/null)" == 1 ]]; then
      ready=1
      break
    fi
    sleep 1
  done
  [[ "$ready" == 1 ]] || {
    echo "Isolated PostgreSQL failed final-server readiness: $name" >&2
    return 1
  }
}

role_password() {
  case "$1" in
    fixture_bootstrap) printf '%s' fixture-bootstrap-ci-only ;;
    fixture_migration) printf '%s' fixture-migration-ci-only ;;
    fixture_maintenance) printf '%s' fixture-maintenance-ci-only ;;
    fixture_backup) printf '%s' fixture-backup-ci-only ;;
    fixture_readonly) printf '%s' fixture-readonly-ci-only ;;
    *) echo "Unknown isolated fixture role" >&2; return 2 ;;
  esac
}

sql() {
  local container="$1" actor="$2" statement="$3"
  docker exec -e "PGPASSWORD=$(role_password "$actor")" "$container" \
    psql -h 127.0.0.1 -X -U "$actor" -d role_fixture \
    -v ON_ERROR_STOP=1 -Atq -c "$statement"
}

sql_in() {
  local container="$1" actor="$2" database="$3" statement="$4"
  docker exec -e "PGPASSWORD=$(role_password "$actor")" "$container" \
    psql -h 127.0.0.1 -X -U "$actor" -d "$database" \
    -v ON_ERROR_STOP=1 -Atq -c "$statement"
}

reject_sql() {
  local container="$1" actor="$2" statement="$3" message="$4"
  if sql "$container" "$actor" "$statement" >/dev/null 2>&1; then
    echo "FAIL: $message unexpectedly succeeded as $actor" >&2
    return 1
  fi
}

# Provision roles and default privileges mirroring the production provisioner
# (tables and sequences SELECT for backup and read-only). Everything after
# this point simulates objects created AFTER the provisioning run.
provision_fixture_roles() {
  local container="$1"
  docker exec -i -e PGPASSWORD=fixture-bootstrap-ci-only "$container" \
    psql -X -h 127.0.0.1 -U fixture_bootstrap \
    -d role_fixture -v ON_ERROR_STOP=1 -q >/dev/null <<'SQL'
CREATE ROLE fixture_migration LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'fixture-migration-ci-only';
CREATE ROLE fixture_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'fixture-backup-ci-only';
CREATE ROLE fixture_readonly LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'fixture-readonly-ci-only';
CREATE ROLE fixture_maintenance LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'fixture-maintenance-ci-only';
CREATE ROLE fixture_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'fixture-runtime-ci-only';
GRANT fixture_migration TO fixture_maintenance;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO fixture_migration;
GRANT USAGE ON SCHEMA public TO fixture_backup, fixture_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE fixture_migration IN SCHEMA public
  GRANT SELECT ON TABLES TO fixture_backup, fixture_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE fixture_migration IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO fixture_backup, fixture_readonly;
CREATE EXTENSION lo;
SQL
}

# The migrator identity creates objects AFTER the provisioning run.
create_migration_large_object() {
  local container="$1" payload="$2"
  sql "$container" fixture_migration \
    "SELECT lo_from_bytea(0, decode('$payload', 'hex'))"
}

create_migration_table() {
  local container="$1"
  sql "$container" fixture_migration "
    CREATE TABLE public.app_records (
      id serial PRIMARY KEY,
      label text NOT NULL
    );
    INSERT INTO public.app_records(label) VALUES ('after-provisioning');
  " >/dev/null
}

run_grant_step() {
  local container="$1" actor="$2" readonly_var="$3"
  docker exec -i -e "PGPASSWORD=$(role_password "$actor")" "$container" \
    psql -h 127.0.0.1 -X -U "$actor" -d role_fixture \
    -v ON_ERROR_STOP=1 \
    -v migrator_user=fixture_migration \
    -v backup_user=fixture_backup \
    -v readonly_user="$readonly_var" \
    < "$grant_sql"
}

assert_restricted() {
  local container="$1" actor="$2" flags
  flags="$(sql "$container" "$actor" "
    SELECT count(*) FROM pg_roles
    WHERE rolname = current_user AND rolcanlogin
      AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
      AND NOT pg_has_role(current_user, 'pg_read_all_data', 'MEMBER')
      AND NOT pg_has_role(current_user, 'pg_write_all_data', 'MEMBER')
      AND NOT pg_has_role(current_user, 'pg_read_server_files', 'MEMBER')
      AND NOT pg_has_role(current_user, 'pg_write_server_files', 'MEMBER')
      AND NOT pg_has_role(current_user, 'pg_execute_server_program', 'MEMBER');
  ")"
  [[ "$flags" == 1 ]] || {
    echo "FAIL: $actor has privileged attributes or inherited powerful roles" >&2
    return 1
  }
}

docker_exec_backup_dump() {
  local container="$1" archive="$2"
  docker exec -e PGPASSWORD=fixture-backup-ci-only "$container" \
    pg_dump -h 127.0.0.1 -U fixture_backup -d role_fixture -Fc > "$archive"
  [[ -s "$archive" ]] || { echo "FAIL: backup-identity dump is empty" >&2; return 1; }
  docker exec -i "$container" pg_restore --list < "$archive" >/dev/null
}

run_case() {
  local label="$1" version="$2"
  local src="${tag}-${label}-source" dst="${tag}-${label}-restore"
  local payload_hex archive loid1 loid2
  payload_hex="$(printf 'POTAPoff-LO-cadence-%s' "$label" | od -An -tx1 | tr -d ' \n')"
  archive="$scratch/${label}.dump"
  echo "LO_CADENCE_BEGIN label=$label postgres=$version"

  start_fixture "$src" "$version" role_fixture
  wait_final_postgres "$src" role_fixture
  provision_fixture_roles "$src"
  create_migration_table "$src"

  # 1. Defect reproduction: a large object created after provisioning is
  #    invisible to the backup identity before the grant step.
  loid1="$(create_migration_large_object "$src" "$payload_hex")"
  [[ "$loid1" =~ ^[0-9]+$ ]] || { echo "FAIL: large object was not created" >&2; return 1; }
  reject_sql "$src" fixture_backup "SELECT lo_get($loid1)" \
    'post-provisioning large object readable by backup before the grant step'

  # 2. The grant step, executed as the migrator owner, opens the object.
  run_grant_step "$src" fixture_migration 'fixture_readonly' >/dev/null
  [[ "$(sql "$src" fixture_backup "SELECT lo_get($loid1) = decode('$payload_hex','hex')")" == t ]] || {
    echo "FAIL: backup cannot read the large object after the grant step" >&2
    return 1
  }
  [[ "$(sql "$src" fixture_readonly "SELECT lo_get($loid1) = decode('$payload_hex','hex')")" == t ]] || {
    echo "FAIL: read-only identity cannot read the large object after the grant step" >&2
    return 1
  }

  # 3. Idempotency and cadence: an object created after an earlier grant run
  #    is covered by the next grant run, and the repeat run changes nothing.
  loid2="$(create_migration_large_object "$src" "$payload_hex")"
  reject_sql "$src" fixture_backup "SELECT lo_get($loid2)" \
    'second post-grant large object readable before the next grant run'
  run_grant_step "$src" fixture_migration 'fixture_readonly' >/dev/null
  [[ "$(sql "$src" fixture_backup "SELECT lo_get($loid1) = decode('$payload_hex','hex') AND lo_get($loid2) = decode('$payload_hex','hex')")" == t ]] || {
    echo "FAIL: the repeated grant run did not cover both large objects" >&2
    return 1
  }

  # 4. The backup identity gains nothing beyond large-object SELECT. Note:
  #    PostgreSQL turns a grant-option-less GRANT by the backup role into a
  #    WARNING (not an error), so the propagation attempt is verified by its
  #    effect: the third role must remain unable to read the object.
  assert_restricted "$src" fixture_backup
  reject_sql "$src" fixture_backup "SELECT lowrite(lo_open($loid1, 131072), 'x')" \
    'backup write to a large object'
  reject_sql "$src" fixture_backup "SELECT lo_unlink($loid1)" \
    'backup unlink of a large object'
  if ! docker exec -e PGPASSWORD=fixture-backup-ci-only "$src" \
    psql -h 127.0.0.1 -X -U fixture_backup -d role_fixture \
    -v ON_ERROR_STOP=1 -q \
    -c "GRANT SELECT ON LARGE OBJECT $loid1 TO fixture_runtime" >/dev/null 2>&1; then
    echo "FAIL: backup propagation GRANT unexpectedly errored instead of warning" >&2
    return 1
  fi
  reject_sql "$src" fixture_runtime "SELECT lo_get($loid1)" \
    'backup propagated its large-object grant to another role'

  # 5. Single-grantee mode (Control Center database has no read-only identity)
  #    executed by a maintenance role that is a member of the migrator.
  run_grant_step "$src" fixture_maintenance '' >/dev/null
  [[ "$(sql "$src" fixture_backup "SELECT lo_get($loid1) = decode('$payload_hex','hex')")" == t ]] || {
    echo "FAIL: maintenance member could not refresh grants in single-grantee mode" >&2
    return 1
  }

  # 6. Full export drill: pg_dump under the backup identity, restore into a
  #    second disconnected container, byte-for-byte content verification.
  docker_exec_backup_dump "$src" "$archive"
  start_fixture "$dst" "$version" restore_target
  wait_final_postgres "$dst" restore_target
  docker exec -i -e PGPASSWORD=fixture-bootstrap-ci-only "$dst" \
    psql -X -h 127.0.0.1 -U fixture_bootstrap -d postgres -v ON_ERROR_STOP=1 -q >/dev/null <<'SQL'
CREATE ROLE fixture_migration LOGIN PASSWORD 'fixture-migration-ci-only';
CREATE ROLE fixture_backup LOGIN PASSWORD 'fixture-backup-ci-only';
CREATE ROLE fixture_readonly LOGIN PASSWORD 'fixture-readonly-ci-only';
CREATE DATABASE role_fixture_restore OWNER fixture_migration;
SQL
  docker exec -i -e PGPASSWORD=fixture-bootstrap-ci-only "$dst" \
    pg_restore -h 127.0.0.1 -U fixture_bootstrap -d role_fixture_restore \
    < "$archive" >/dev/null
  [[ "$(sql_in "$dst" fixture_migration role_fixture_restore "SELECT lo_get($loid1) = decode('$payload_hex','hex')")" == t ]] || {
    echo "FAIL: large object content lost after restore" >&2
    return 1
  }
  [[ "$(sql_in "$dst" fixture_migration role_fixture_restore "SELECT count(*) FROM public.app_records WHERE label = 'after-provisioning'")" == 1 ]] || {
    echo "FAIL: post-provisioning row lost after restore" >&2
    return 1
  }
  [[ "$(sql_in "$dst" fixture_backup role_fixture_restore "SELECT lo_get($loid1) = decode('$payload_hex','hex')")" == t ]] || {
    echo "FAIL: restored large object ACL lost the backup SELECT grant" >&2
    return 1
  }

  # 7. Fail closed on large objects owned outside the migrator identity.
  sql "$src" fixture_bootstrap "SELECT lo_from_bytea(0, '0000'::bytea)" >/dev/null
  if run_grant_step "$src" fixture_migration 'fixture_readonly' >/dev/null 2>&1; then
    echo "FAIL: foreign-owned large object did not block the grant step" >&2
    return 1
  fi
  sql "$src" fixture_bootstrap \
    "SELECT lo_unlink(min(oid)) FROM pg_largeobject_metadata WHERE pg_get_userbyid(lomowner) = 'fixture_bootstrap'" >/dev/null
  run_grant_step "$src" fixture_migration 'fixture_readonly' >/dev/null
  [[ "$(sql "$src" fixture_backup "SELECT lo_get($loid2) = decode('$payload_hex','hex')")" == t ]] || {
    echo "FAIL: grant step did not recover after the foreign-owned object was removed" >&2
    return 1
  }

  echo "LO_CADENCE_PASS label=$label postgres=$version"
}

run_case pg16 16
run_case pg17 17
echo "LARGE-OBJECT GRANT CADENCE DRILL COMPLETE"
