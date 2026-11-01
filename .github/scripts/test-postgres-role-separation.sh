#!/usr/bin/env bash
# Synthetic, disconnected role-boundary and pg_dump/restore test.
# NO real cluster, service, persistent volume, password or network port is used.
set -euo pipefail

command -v docker >/dev/null
scratch="$(mktemp -d)"
tag="role-rehearsal-${RANDOM}-$$"
containers=()
cleanup() {
  for name in "${containers[@]}"; do
    docker rm -f "$name" >/dev/null 2>&1 || true
  done
  rm -rf "$scratch"
}
trap cleanup EXIT

start_fixture() {
  local name="$1" version="$2"
  containers+=("$name")
  docker run -d --rm --network none --name "$name" \
    -e POSTGRES_USER=fixture_bootstrap \
    -e POSTGRES_DB=role_fixture \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    "postgres:${version}-alpine" >/dev/null
}

wait_final_postgres() {
  local name="$1" ready=0
  for ((i=0; i<60; i++)); do
    # The entrypoint starts and stops a temporary Unix-socket-only server.
    # Require final init completion AND an actual TCP SQL round-trip.
    if docker logs "$name" 2>&1 | grep -Fq 'PostgreSQL init process complete; ready for start up.' &&
       [[ "$(docker exec "$name" psql -X -h 127.0.0.1 \
         -U fixture_bootstrap -d role_fixture -v ON_ERROR_STOP=1 \
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

sql() {
  local container="$1" actor="$2" statement="$3"
  docker exec "$container" psql -h 127.0.0.1 -X \
    -U "$actor" -d role_fixture -v ON_ERROR_STOP=1 -Atq -c "$statement"
}

reject_sql() {
  local container="$1" actor="$2" statement="$3" message="$4"
  if sql "$container" "$actor" "$statement" >/dev/null 2>&1; then
    echo "FAIL: $message unexpectedly succeeded as $actor" >&2
    return 1
  fi
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

run_case() {
  local label="$1" version="$2"
  local src="${tag}-${label}-source" dst="${tag}-${label}-restore"
  local archive="$scratch/${label}.dump"
  echo "REHEARSAL_BEGIN label=$label postgres=$version"

  start_fixture "$src" "$version"
  wait_final_postgres "$src"
  [[ "$(sql "$src" fixture_bootstrap     "SELECT rolsuper FROM pg_roles WHERE rolname=current_user")" == t ]] || {
    echo 'Expected fixture bootstrap to be superuser' >&2
    return 1
  }

  # All privileges below are created in a disposable cluster only.
  # Runtime and backup cannot own or create objects. Migration owns app
  # objects and is the ONLY login allowed to alter them.
  docker exec -i "$src" psql -X -h 127.0.0.1 -U fixture_bootstrap \
    -d role_fixture -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
CREATE ROLE fixture_migration LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE fixture_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE fixture_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE ALL ON DATABASE role_fixture FROM PUBLIC;
GRANT CONNECT ON DATABASE role_fixture TO fixture_migration, fixture_runtime, fixture_backup;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO fixture_migration;
GRANT USAGE ON SCHEMA public TO fixture_runtime, fixture_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE fixture_migration IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fixture_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE fixture_migration IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO fixture_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE fixture_migration IN SCHEMA public
  GRANT SELECT ON TABLES TO fixture_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE fixture_migration IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO fixture_backup;
SQL

  for actor in fixture_migration fixture_runtime fixture_backup; do
    assert_restricted "$src" "$actor"
    reject_sql "$src" "$actor" "SET ROLE fixture_bootstrap" \
      'privilege escalation via SET ROLE'
  done

  sql "$src" fixture_migration "
    CREATE TABLE public.app_records (
      id serial PRIMARY KEY,
      label text NOT NULL
    );
    INSERT INTO public.app_records(label) VALUES ('migration');
    ALTER TABLE public.app_records ADD COLUMN note text;
  " >/dev/null

  [[ "$(sql "$src" fixture_runtime \
    "INSERT INTO public.app_records(label) VALUES ('runtime') RETURNING id")" == 2 ]]
  [[ "$(sql "$src" fixture_runtime \
    "SELECT count(*) FROM public.app_records")" == 2 ]]
  sql "$src" fixture_runtime \
    "UPDATE public.app_records SET note='ok' WHERE label='runtime'" >/dev/null

  # Rehearse the actual migration trap: a schema grant does not let the
  # migrator ALTER pre-existing objects still owned by the legacy bootstrap.
  sql "$src" fixture_bootstrap "
    CREATE TABLE public.legacy_records (id integer PRIMARY KEY, label text NOT NULL);
    INSERT INTO public.legacy_records VALUES (1, 'legacy-owner');
    CREATE TABLE public.alembic_version (version_num varchar(32) PRIMARY KEY);
    INSERT INTO public.alembic_version VALUES ('test_revision');
  " >/dev/null
  reject_sql "$src" fixture_migration \
    "ALTER TABLE public.legacy_records ADD COLUMN note text" \
    'migration ALTER on legacy bootstrap-owned table before transfer'
  # The isolated fixture uses an explicit, reviewed object allowlist rather
  # than a dangerous database-wide REASSIGN OWNED operation.
  sql "$src" fixture_bootstrap "
    ALTER TABLE public.legacy_records OWNER TO fixture_migration;
    ALTER TABLE public.alembic_version OWNER TO fixture_migration;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.legacy_records TO fixture_runtime;
    GRANT SELECT ON public.legacy_records, public.alembic_version TO fixture_backup;
  " >/dev/null
  sql "$src" fixture_migration \
    "ALTER TABLE public.legacy_records ADD COLUMN note text" >/dev/null
  sql "$src" fixture_runtime \
    "INSERT INTO public.legacy_records(id, label) VALUES (2, 'legacy-granted')" >/dev/null
  reject_sql "$src" fixture_runtime \
    "UPDATE public.alembic_version SET version_num='tampered'" \
    'runtime write to Alembic migration ledger'
  [[ "$(sql "$src" fixture_backup \
    "SELECT count(*) FROM public.legacy_records")" == 2 ]]

  # Default privileges must apply to tables created AFTER the initial grants.
  sql "$src" fixture_migration \
    "CREATE TABLE public.later_records (id integer PRIMARY KEY, label text)" >/dev/null
  sql "$src" fixture_runtime \
    "INSERT INTO public.later_records VALUES (7, 'granted-by-default')" >/dev/null
  [[ "$(sql "$src" fixture_backup \
    "SELECT label FROM public.later_records WHERE id=7")" == "granted-by-default" ]]

  reject_sql "$src" fixture_runtime \
    "CREATE TABLE public.unauthorized(id int)" 'runtime CREATE TABLE'
  reject_sql "$src" fixture_runtime \
    "ALTER TABLE public.app_records ADD COLUMN unauthorized int" 'runtime ALTER TABLE'
  reject_sql "$src" fixture_runtime \
    "CREATE ROLE unwanted_login LOGIN" 'runtime CREATE ROLE'
  reject_sql "$src" fixture_backup \
    "INSERT INTO public.app_records(label) VALUES ('unauthorized')" 'backup INSERT'
  reject_sql "$src" fixture_backup \
    "UPDATE public.app_records SET label='unauthorized'" 'backup UPDATE'
  reject_sql "$src" fixture_backup \
    "CREATE TABLE public.unauthorized(id int)" 'backup CREATE TABLE'
  reject_sql "$src" fixture_backup \
    "SET ROLE fixture_migration" 'backup migration-role impersonation'
  [[ "$(sql "$src" fixture_backup \
    "SELECT count(*) FROM public.app_records")" == 2 ]]

  # Custom-format backup by a genuine non-superuser backup login.
  # A missing SELECT grant causes pg_dump to fail and therefore fails CI.
  docker exec "$src" pg_dump -h 127.0.0.1 -U fixture_backup \
    -d role_fixture --format=custom --no-owner --no-acl > "$archive"
  test -s "$archive"
  docker exec -i "$src" pg_restore --list < "$archive" >/dev/null

  start_fixture "$dst" "$version"
  wait_final_postgres "$dst"
  docker exec -i "$dst" pg_restore -h 127.0.0.1 -U fixture_bootstrap \
    --exit-on-error --no-owner --no-acl -d role_fixture < "$archive"

  [[ "$(sql "$dst" fixture_bootstrap \
    "SELECT string_agg(label, ',' ORDER BY id) FROM public.app_records")" == "migration,runtime" ]]
  [[ "$(sql "$dst" fixture_bootstrap \
    "SELECT label FROM public.later_records WHERE id=7")" == "granted-by-default" ]]
  [[ "$(sql "$dst" fixture_bootstrap \
    "SELECT count(*) FROM public.legacy_records")" == 2 ]]
  [[ "$(sql "$dst" fixture_bootstrap \
    "SELECT version_num FROM public.alembic_version")" == test_revision ]]
  [[ "$(sql "$dst" fixture_bootstrap \
    "INSERT INTO public.app_records(label) VALUES ('restored') RETURNING id")" == 3 ]]
  echo "ROLE_REHEARSAL_OK label=$label postgres=$version"
}

run_case product 16
run_case admin 17
echo 'POSTGRES_ROLE_SEPARATION_REHEARSAL_OK isolated_disposable_only'
