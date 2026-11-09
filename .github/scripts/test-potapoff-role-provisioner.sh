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

docker run -d --network none --pids-limit 256 --name "$container" \
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

original_schema_owner="$(run_psql "$bootstrap_user" "$bootstrap_password" -Atq -c \
  "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public'")"

# Seed bootstrap-owned legacy objects. The provisioner must not silently
# transfer any of these objects to the migration role.
run_psql "$bootstrap_user" "$bootstrap_password" -c "GRANT CREATE ON DATABASE potapoff_ci TO PUBLIC" >/dev/null
run_psql "$bootstrap_user" "$bootstrap_password" -c "GRANT CREATE ON SCHEMA public TO PUBLIC" >/dev/null
run_psql "$bootstrap_user" "$bootstrap_password" -c "CREATE TYPE public.legacy_state AS ENUM ('old','new')" >/dev/null
run_psql "$bootstrap_user" "$bootstrap_password" -c "CREATE TYPE public.legacy_composite AS (payload text)" >/dev/null
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
  CREATE FUNCTION public.legacy_security_definer() RETURNS integer
    LANGUAGE sql SECURITY DEFINER AS \$\$ SELECT 1 \$\$;
  REVOKE ALL ON FUNCTION public.legacy_security_definer() FROM PUBLIC;
  CREATE FUNCTION public.legacy_security_definer_second() RETURNS integer
    LANGUAGE sql SECURITY DEFINER AS \$\$ SELECT 2 \$\$;
  REVOKE ALL ON FUNCTION public.legacy_security_definer_second() FROM PUBLIC;
" >/dev/null

docker cp "$root/solana-launcher/scripts/provision-postgres-roles.sql" "$container:/tmp/provision-postgres-roles.sql" >/dev/null
docker cp "$root/solana-launcher/scripts/check-postgres-migrator-ownership.sql" "$container:/tmp/check-postgres-migrator-ownership.sql" >/dev/null

# Bootstrap-owned application objects must block provisioning before any
# password, role attribute, membership or ACL is changed.
if run_psql "$bootstrap_user" "$bootstrap_password" \
  -v bootstrap_user="$bootstrap_user" \
  -v app_user="$app_user" -v app_password="$app_password" \
  -v migrator_user="$migrator_user" -v migrator_password="$migrator_password" \
  -v backup_user="$backup_user" -v backup_password="$backup_password" \
  -v readonly_user="$readonly_user" -v readonly_password="$readonly_password" \
  -f /tmp/provision-postgres-roles.sql >/dev/null 2>&1; then
  echo "Role provisioner accepted bootstrap-owned legacy objects" >&2
  exit 1
fi
roles_after_failed_preflight="$(run_psql "$bootstrap_user" "$bootstrap_password" -Atq -c \
  "SELECT count(*) FROM pg_roles WHERE rolname IN ('$app_user','$migrator_user','$backup_user','$readonly_user')")"
[[ "$roles_after_failed_preflight" == "0" ]] || {
  echo "Failed ownership preflight changed role state: $roles_after_failed_preflight" >&2
  exit 1
}

# Disposable, explicit object-level owner allowlist. Production provisioning
# never performs this transfer; operators must review and rehearse it separately.
run_psql "$bootstrap_user" "$bootstrap_password" -c "
  CREATE ROLE $migrator_user NOLOGIN;
  GRANT CREATE ON SCHEMA public TO $migrator_user;
  ALTER TABLE public.legacy_records OWNER TO $migrator_user;
  ALTER TABLE public.alembic_version OWNER TO $migrator_user;
  ALTER VIEW public.legacy_projection OWNER TO $migrator_user;
  ALTER SEQUENCE public.legacy_records_id_seq OWNER TO $migrator_user;
  ALTER FUNCTION public.legacy_label_count() OWNER TO $migrator_user;
  ALTER FUNCTION public.legacy_security_definer() OWNER TO $migrator_user;
  ALTER FUNCTION public.legacy_security_definer_second() OWNER TO $migrator_user;
  ALTER TYPE public.legacy_state OWNER TO $migrator_user;
  ALTER TYPE public.legacy_composite OWNER TO $migrator_user;
" >/dev/null

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
  "SELECT count(*) FROM pg_namespace n WHERE n.nspname <> 'public' AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%' AND has_schema_privilege('$migrator_user', n.oid, 'CREATE')")" == "0" ]]
for role in "$app_user" "$backup_user" "$readonly_user"; do
  [[ "$(run_psql "$bootstrap_user" "$bootstrap_password" -Atq -c \
    "SELECT has_database_privilege('$role', current_database(), 'CREATE')")" == "f" ]]
  [[ "$(run_psql "$bootstrap_user" "$bootstrap_password" -Atq -c \
    "SELECT count(*) FROM pg_namespace n WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%' AND has_schema_privilege('$role', n.oid, 'CREATE')")" == "0" ]]
done
[[ "$(run_psql "$bootstrap_user" "$bootstrap_password" -Atq -c \
  "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.legacy_records'::regclass")" == "$bootstrap_user" ]]
[[ "$(run_psql "$bootstrap_user" "$bootstrap_password" -Atq -c \
  "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='public'")" == "$original_schema_owner" ]]
[[ "$(run_psql "$backup_user" "$backup_password" -Atq -c "SHOW default_transaction_read_only")" == "on" ]]
[[ "$(run_psql "$readonly_user" "$readonly_password" -Atq -c "SHOW default_transaction_read_only")" == "on" ]]

# The dedicated backup login must be able to dump ordinary application data.
archive="$scratch/potapoff-role-provisioner.dump"
docker exec -e PGPASSWORD="$backup_password" "$container" \
  pg_dump -h 127.0.0.1 -U "$backup_user" -d potapoff_ci -Fc > "$archive"
test -s "$archive"
docker exec -i "$container" pg_restore --list < "$archive" >/dev/null
[[ "$(run_psql "$backup_user" "$backup_password" -Atq -c \
  "SELECT pg_has_role(current_user, 'pg_read_all_data', 'MEMBER')")" == "f" ]]

# After the explicit allowlist and role provisioning, the deployment guard
# should pass without changing any database object.
run_psql "$bootstrap_user" "$bootstrap_password" -v bootstrap_user="$bootstrap_user" -v migrator_user="$migrator_user" \
  -v app_user="$app_user" -v backup_user="$backup_user" -v readonly_user="$readonly_user" \
  -f /tmp/check-postgres-migrator-ownership.sql >/dev/null

# A standalone composite type remains independently covered by the ownership gate.
run_psql "$bootstrap_user" "$bootstrap_password" -c \
  "ALTER TYPE public.legacy_composite OWNER TO $bootstrap_user" >/dev/null
if run_psql "$bootstrap_user" "$bootstrap_password" -v bootstrap_user="$bootstrap_user" -v migrator_user="$migrator_user" \
  -v app_user="$app_user" -v backup_user="$backup_user" -v readonly_user="$readonly_user" \
  -f /tmp/check-postgres-migrator-ownership.sql >"$scratch/composite-ownership.log" 2>&1; then
  echo "Ownership guard unexpectedly accepted a bootstrap-owned composite type" >&2
  exit 1
fi
grep -Fq "non-extension application objects are not owned by the migration role" "$scratch/composite-ownership.log" || {
  cat "$scratch/composite-ownership.log" >&2
  echo "Ownership guard failed for the wrong reason; composite-type ownership was not detected" >&2
  exit 1
}
run_psql "$bootstrap_user" "$bootstrap_password" -c \
  "ALTER TYPE public.legacy_composite OWNER TO $migrator_user" >/dev/null

# PUBLIC EXECUTE on SECURITY DEFINER code must block the same deployment gate.
run_psql "$bootstrap_user" "$bootstrap_password" -c \
  "GRANT EXECUTE ON FUNCTION public.legacy_security_definer() TO PUBLIC" >/dev/null
if run_psql "$bootstrap_user" "$bootstrap_password" -v bootstrap_user="$bootstrap_user" -v migrator_user="$migrator_user" \
  -v app_user="$app_user" -v backup_user="$backup_user" -v readonly_user="$readonly_user" \
  -f /tmp/check-postgres-migrator-ownership.sql >/dev/null 2>&1; then
  echo "Ownership guard unexpectedly accepted a PUBLIC-executable SECURITY DEFINER function" >&2
  exit 1
fi
run_psql "$bootstrap_user" "$bootstrap_password" -c "
  REVOKE ALL ON FUNCTION public.legacy_security_definer() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.legacy_security_definer() TO $app_user;
" >/dev/null
run_psql "$bootstrap_user" "$bootstrap_password" -v bootstrap_user="$bootstrap_user" -v migrator_user="$migrator_user" \
  -v app_user="$app_user" -v backup_user="$backup_user" -v readonly_user="$readonly_user" \
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
[[ "$(run_psql "$app_user" "$app_password" -Atq -c \
  "SELECT public.legacy_security_definer()")" == "1" ]]
[[ "$(run_psql "$app_user" "$app_password" -Atq -c \
  "SELECT public.legacy_security_definer_second()")" == "2" ]]
if run_psql "$backup_user" "$backup_password" -c \
  "SELECT public.legacy_security_definer()" >/dev/null 2>&1; then
  echo "Backup role unexpectedly executed a SECURITY DEFINER function" >&2
  exit 1
fi
if run_psql "$backup_user" "$backup_password" -c \
  "SELECT public.legacy_security_definer_second()" >/dev/null 2>&1; then
  echo "Backup role unexpectedly executed a second SECURITY DEFINER function" >&2
  exit 1
fi
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

# Seed stale memberships and unsafe attributes as if an earlier deployment
# had granted broad roles. The idempotent provisioner must remove both inbound
# and outbound memberships and reset all restricted role flags.
run_psql "$bootstrap_user" "$bootstrap_password" -c "
  CREATE ROLE potapoff_legacy_parent NOLOGIN;
  GRANT potapoff_legacy_parent TO $app_user;
  GRANT $backup_user TO potapoff_legacy_parent;
  GRANT pg_read_all_data TO $backup_user;
  ALTER ROLE $app_user WITH INHERIT CREATEDB;
  ALTER ROLE $backup_user WITH BYPASSRLS;
" >/dev/null

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

for role in "$app_user" "$migrator_user" "$backup_user" "$readonly_user"; do
  flags="$(run_psql "$bootstrap_user" "$bootstrap_password" -Atq -c "
    SELECT rolsuper::text || '|' || rolcreatedb::text || '|' ||
           rolcreaterole::text || '|' || rolreplication::text || '|' ||
           rolbypassrls::text || '|' || rolinherit::text
    FROM pg_roles WHERE rolname='$role'
  ")"
  [[ "$flags" == "false|false|false|false|false|false" ]] || {
    echo "$role retained unsafe role attributes after re-provisioning: $flags" >&2
    exit 1
  }
  memberships="$(run_psql "$bootstrap_user" "$bootstrap_password" -Atq -c "
    SELECT count(*) FROM pg_auth_members m
    JOIN pg_roles member ON member.oid=m.member
    JOIN pg_roles granted ON granted.oid=m.roleid
    WHERE member.rolname='$role' OR granted.rolname='$role'
  ")"
  [[ "$memberships" == "0" ]] || {
    echo "$role retained stale role memberships after re-provisioning" >&2
    exit 1
  }
done

echo "POTAPOFF_ROLE_PROVISIONER_REHEARSAL_OK no_blanket_reassign=true backup_no_bypassrls=true ownership_guard=true"
