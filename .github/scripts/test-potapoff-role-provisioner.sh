#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container="potapoff-role-provisioner-ci-${GITHUB_RUN_ID:-local}-$$"
bootstrap_user=potapoff_bootstrap
bootstrap_password=ci-bootstrap-password
app_user=potapoff_app
app_password=ci-app-password
migrator_user=potapoff_migrator
migrator_password=ci-migrator-password
backup_user=potapoff_backup
backup_password=ci-backup-password
readonly_user=potapoff_readonly
readonly_password=ci-readonly-password
scratch="$(mktemp -d)"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

docker run -d --name "$container" \
  -e POSTGRES_USER="$bootstrap_user" \
  -e POSTGRES_PASSWORD="$bootstrap_password" \
  -e POSTGRES_DB=potapoff_ci \
  postgres:16-alpine >/dev/null

ready=false
for _ in $(seq 1 60); do
  if docker exec -e PGHOST=127.0.0.1 -e PGUSER="$bootstrap_user" -e PGPASSWORD="$bootstrap_password" "$container" \
    psql -X -v ON_ERROR_STOP=1 -d potapoff_ci -Atq -c 'SELECT 1' 2>/dev/null | grep -qx '1'; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  docker logs "$container"
  echo "Temporary PostgreSQL did not become ready" >&2
  exit 1
fi

run_psql() {
  local user="$1" password="$2"
  shift 2
  docker exec -e PGHOST=127.0.0.1 -e PGUSER="$user" -e PGPASSWORD="$password" "$container" \
    psql -X -v ON_ERROR_STOP=1 -d potapoff_ci "$@"
}

# Seed bootstrap-owned legacy objects. The provisioner must not silently
# transfer any of these objects to the migration role.
run_psql "$bootstrap_user" "$bootstrap_password" -c "CREATE TYPE public.legacy_state AS ENUM ('old','new')" >/dev/null
run_psql "$bootstrap_user" "$bootstrap_password" -c "
  CREATE TABLE public.legacy_records (
    id bigserial PRIMARY KEY,
    label text NOT NULL,
    state public.legacy_state
  );
" >/dev/null
run_psql "$bootstrap_user" "$bootstrap_password" -c "
  INSERT INTO public.legacy_records(label, state) VALUES ('legacy-row', 'old');
  CREATE TABLE public.alembic_version(version_num varchar(64) PRIMARY KEY);
  INSERT INTO public.alembic_version VALUES ('legacy_revision');
  CREATE VIEW public.legacy_projection AS SELECT id, label FROM public.legacy_records;
  CREATE FUNCTION public.legacy_label_count() RETURNS bigint
    LANGUAGE sql STABLE AS \$\$ SELECT count(*) FROM public.legacy_records \$\$;
  REVOKE ALL ON FUNCTION public.legacy_label_count() FROM PUBLIC;
" >/dev/null

docker cp "$root/solana-launcher/scripts/provision-postgres-roles.sql" "$container:/tmp/provision-postgres-roles.sql" >/dev/null
docker cp "$root/solana-launcher/scripts/check-postgres-migrator-ownership.sql" "$container:/tmp/check-postgres-migrator-ownership.sql" >/dev/null

run_psql "$bootstrap_user" "$bootstrap_password" \
  -v bootstrap_user="$bootstrap_user" \
  -v app_user="$app_user" -v app_password="$app_password" \
  -v migrator_user="$migrator_user" -v migrator_password="$migrator_password" \
  -v backup_user="$backup_user" -v backup_password="$backup_password" \
  -v readonly_user="$readonly_user" -v readonly_password="$readonly_password" \
  -f /tmp/provision-postgres-roles.sql >/dev/null

# Provisioning is idempotent and must not make a bootstrap-owned table appear
# migrator-owned. It grants DML/SELECT only, not database ownership or RLS bypass.
for role in "$app_user" "$migrator_user" "$backup_user" "$readonly_user"; do
  flags="$(run_psql "$bootstrap_user" "$bootstrap_password" -Atq -c "
    SELECT rolsuper::text || '|' || rolcreatedb::text || '|' ||
           rolcreaterole::text || '|' || rolreplication::text || '|' ||
           rolbypassrls::text || '|' || rolinherit::text
    FROM pg_roles WHERE rolname='$role'
  ")"
  [[ "$flags" == "false|false|false|false|false|false" ]] || {
    echo "$role has unsafe role attributes: $flags" >&2
    exit 1
  }
  memberships="$(run_psql "$bootstrap_user" "$bootstrap_password" -Atq -c "
    SELECT count(*) FROM pg_auth_members m
    JOIN pg_roles member ON member.oid=m.member
    JOIN pg_roles granted ON granted.oid=m.roleid
    WHERE member.rolname='$role' OR granted.rolname='$role'
  ")"
  [[ "$memberships" == "0" ]] || { echo "$role has unexpected role memberships" >&2; exit 1; }
done

[[ "$(run_psql "$bootstrap_user" "$bootstrap_password" -Atq -c \
  "SELECT has_database_privilege('$migrator_user', current_database(), 'CREATE')")" == "f" ]]
[[ "$(run_psql "$bootstrap_user" "$bootstrap_password" -Atq -c \
  "SELECT has_schema_privilege('$migrator_user', 'public', 'CREATE')")" == "t" ]]
[[ "$(run_psql "$bootstrap_user" "$bootstrap_password" -Atq -c \
  "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.legacy_records'::regclass")" == "$bootstrap_user" ]]
[[ "$(run_psql "$bootstrap_user" "$bootstrap_password" -Atq -c \
  "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public'")" == "$bootstrap_user" ]]
[[ "$(run_psql "$backup_user" "$backup_password" -Atq -c "SHOW default_transaction_read_only")" == "on" ]]
[[ "$(run_psql "$readonly_user" "$readonly_password" -Atq -c "SHOW default_transaction_read_only")" == "on" ]]
[[ "$(run_psql "$backup_user" "$backup_password" -Atq -c \
  "SELECT pg_has_role(current_user, 'pg_read_all_data', 'MEMBER')")" == "f" ]]

# The deployment guard must block before the reviewed object-level cutover.
if run_psql "$bootstrap_user" "$bootstrap_password" -v migrator_user="$migrator_user" \
  -f /tmp/check-postgres-migrator-ownership.sql >/dev/null 2>&1; then
  echo "Ownership guard unexpectedly accepted bootstrap-owned legacy objects" >&2
  exit 1
fi

# Simulate the separately reviewed allowlist from the disposable inventory.
run_psql "$bootstrap_user" "$bootstrap_password" -c "
  ALTER TABLE public.legacy_records OWNER TO $migrator_user;
  ALTER SEQUENCE public.legacy_records_id_seq OWNER TO $migrator_user;
  ALTER TABLE public.alembic_version OWNER TO $migrator_user;
  ALTER VIEW public.legacy_projection OWNER TO $migrator_user;
  ALTER FUNCTION public.legacy_label_count() OWNER TO $migrator_user;
  ALTER TYPE public.legacy_state OWNER TO $migrator_user;
  GRANT EXECUTE ON FUNCTION public.legacy_label_count() TO $app_user;
" >/dev/null

run_psql "$bootstrap_user" "$bootstrap_password" -v migrator_user="$migrator_user" \
  -f /tmp/check-postgres-migrator-ownership.sql >/dev/null

# Migration DDL succeeds only after the allowlisted ownership transfer.
run_psql "$migrator_user" "$migrator_password" -c "
  ALTER TABLE public.legacy_records ADD COLUMN note text;
  CREATE TABLE public.migration_created(id integer PRIMARY KEY, label text);
  INSERT INTO public.migration_created VALUES (1, 'migration');
" >/dev/null

# New migration-created functions must not inherit PostgreSQL's default PUBLIC EXECUTE.
run_psql "$migrator_user" "$migrator_password" -c \
  "CREATE FUNCTION public.migration_private_fn() RETURNS integer LANGUAGE sql AS \$\$ SELECT 7 \$\$" >/dev/null
for role in "$app_user" "$backup_user" "$readonly_user"; do
  case "$role" in
    "$app_user") role_password="$app_password" ;;
    "$backup_user") role_password="$backup_password" ;;
    *) role_password="$readonly_password" ;;
  esac
  if run_psql "$role" "$role_password" -c "SELECT public.migration_private_fn()" >/dev/null 2>&1; then
    echo "$role unexpectedly executed a function without an explicit grant" >&2
    exit 1
  fi
done
run_psql "$bootstrap_user" "$bootstrap_password" -c \
  "GRANT EXECUTE ON FUNCTION public.migration_private_fn() TO $app_user" >/dev/null
[[ "$(run_psql "$app_user" "$app_password" -Atq -c "SELECT public.migration_private_fn()")" == "7" ]]

# Runtime DML and backup/read-only SELECT are allowed on migration-created data.
run_psql "$app_user" "$app_password" -c "
  INSERT INTO public.migration_created VALUES (2, 'runtime');
  UPDATE public.migration_created SET label='updated' WHERE id=2;
  DELETE FROM public.migration_created WHERE id=2;
" >/dev/null
[[ "$(run_psql "$backup_user" "$backup_password" -Atq -c \
  "SELECT label FROM public.migration_created WHERE id=1")" == "migration" ]]
[[ "$(run_psql "$readonly_user" "$readonly_password" -Atq -c \
  "SELECT label FROM public.migration_created WHERE id=1")" == "migration" ]]

[[ "$(run_psql "$app_user" "$app_password" -Atq -c \
  "SELECT public.legacy_label_count()")" == "1" ]]
if run_psql "$backup_user" "$backup_password" -c \
  "SELECT public.legacy_label_count()" >/dev/null 2>&1; then
  echo "Backup role unexpectedly executed an application function" >&2
  exit 1
fi

for role in "$app_user" "$backup_user" "$readonly_user"; do
  case "$role" in
    "$app_user") role_password="$app_password" ;;
    "$backup_user") role_password="$backup_password" ;;
    *) role_password="$readonly_password" ;;
  esac
  if run_psql "$role" "$role_password" -c "CREATE TABLE public.must_not_ddl(id integer)" >/dev/null 2>&1; then
    echo "$role unexpectedly created a table" >&2
    exit 1
  fi
done
if run_psql "$backup_user" "$backup_password" -c \
  "INSERT INTO public.migration_created VALUES (3, 'must-not-write')" >/dev/null 2>&1; then
  echo "Backup role unexpectedly wrote data" >&2
  exit 1
fi
if run_psql "$readonly_user" "$readonly_password" -c \
  "INSERT INTO public.migration_created VALUES (3, 'must-not-write')" >/dev/null 2>&1; then
  echo "Read-only role unexpectedly wrote data" >&2
  exit 1
fi

# RLS must not be bypassed by the backup login. A pg_dump/row-security-off
# read of this protected relation fails closed instead of silently omitting rows.
run_psql "$migrator_user" "$migrator_password" -c "
  CREATE TABLE public.rls_probe(id integer PRIMARY KEY);
  ALTER TABLE public.rls_probe ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.rls_probe FORCE ROW LEVEL SECURITY;
  CREATE POLICY deny_select ON public.rls_probe FOR SELECT USING (false);
  CREATE POLICY allow_insert ON public.rls_probe FOR INSERT WITH CHECK (true);
  INSERT INTO public.rls_probe VALUES (1);
" >/dev/null
if run_psql "$backup_user" "$backup_password" -c \
  "SET row_security=off; SELECT * FROM public.rls_probe" >/dev/null 2>&1; then
  echo "Backup role unexpectedly bypassed row-level security" >&2
  exit 1
fi

# Re-running provisioning must preserve the manual allowlist transfer and the
# restricted role boundaries.
run_psql "$bootstrap_user" "$bootstrap_password" \
  -v bootstrap_user="$bootstrap_user" \
  -v app_user="$app_user" -v app_password="$app_password" \
  -v migrator_user="$migrator_user" -v migrator_password="$migrator_password" \
  -v backup_user="$backup_user" -v backup_password="$backup_password" \
  -v readonly_user="$readonly_user" -v readonly_password="$readonly_password" \
  -f /tmp/provision-postgres-roles.sql >/dev/null
[[ "$(run_psql "$bootstrap_user" "$bootstrap_password" -Atq -c \
  "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.legacy_records'::regclass")" == "$migrator_user" ]]

echo "POTAPOFF_ROLE_PROVISIONER_REHEARSAL_OK no_blanket_reassign=true backup_no_bypassrls=true ownership_guard=true"
