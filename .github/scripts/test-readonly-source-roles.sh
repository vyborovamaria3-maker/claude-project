#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container="source-role-ci-${GITHUB_RUN_ID:-local}-$$"
bootstrap_password="ci-bootstrap-password"
app_password="ci-app-password"
migrator_password="ci-migrator-password"
readonly_password="ci-readonly-password"

# These provisioners must never transfer existing owners or grant broad
# predefined read/bypass roles; they must stop before role changes on mismatch.
for provisioner in \
  "$repo_root/memecoin-intelligence/scripts/provision-readonly-role.sql" \
  "$repo_root/solana-subscription-service/scripts/provision-readonly-role.sql"; do
  if grep -Eiq '^[[:space:]]*REASSIGN[[:space:]]+OWNED([[:space:]]|$)|GRANT[[:space:]]+pg_read_all_data|[[:space:]]BYPASSRLS([;[:space:]]|$)' "$provisioner"; then
    echo "Unsafe automatic ownership or broad read/bypass grant in $provisioner" >&2
    exit 1
  fi
  grep -Fq 'has_unprepared_application_owners' "$provisioner"
  grep -Fq 'has_public_security_definer_execute' "$provisioner"
done

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
  # Simulate a legacy database upgraded from a PostgreSQL version where
  # PUBLIC still had CREATE on the public schema.
  run_psql "$database" postgres "$bootstrap_password" -c \
    "GRANT CREATE ON DATABASE $database TO PUBLIC; GRANT CREATE ON SCHEMA public TO PUBLIC" >/dev/null
  run_psql "$database" postgres "$bootstrap_password" -c \
    "CREATE TABLE source_probe (id integer PRIMARY KEY, value text); INSERT INTO source_probe VALUES (1, 'visible'); GRANT INSERT, UPDATE, DELETE ON TABLE public.source_probe TO PUBLIC" >/dev/null

  docker exec "$container" mkdir -p /provision
  docker cp "$repo_root/$sql_path" "$container:/provision/readonly-role.sql" >/dev/null
  docker cp "$repo_root/$entrypoint_path" "$container:/provision/run-readonly-role-provisioner.sh" >/dev/null
  if grep -Eq '^[[:space:]]*DO[[:space:]]+\$[[:space:]]*$|^[[:space:]]*\$;[[:space:]]*$' /provision/readonly-role.sql; then
    echo "Malformed DO dollar-quote delimiter in $sql_path" >&2
    return 1
  fi

  run_provisioner() {
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
      "$container" /bin/sh /provision/run-readonly-role-provisioner.sh
  }

  # Verify the fixture really contains a bootstrap-owned application table,
  # then require the provisioner to fail specifically at the ownership gate.
  local source_probe_owner provisioner_log
  source_probe_owner="$(run_psql "$database" postgres "$bootstrap_password" -Atq -c \
    "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.source_probe'::regclass")"
  [[ "$source_probe_owner" == "postgres" ]] || {
    echo "$database fixture source_probe owner is unexpected: $source_probe_owner" >&2
    return 1
  }
  provisioner_log="$(mktemp)"
  if run_provisioner >"$provisioner_log" 2>&1; then
    rm -f "$provisioner_log"
    echo "$database accepted a bootstrap-owned application object" >&2
    return 1
  fi
  if ! grep -Fq 'object-level allowlist' "$provisioner_log"; then
    cat "$provisioner_log" >&2
    rm -f "$provisioner_log"
    echo "$database provisioner failed before the ownership guard" >&2
    return 1
  fi
  rm -f "$provisioner_log"
  [[ "$(run_psql "$database" postgres "$bootstrap_password" -Atq -c \
    "SELECT count(*) FROM pg_roles WHERE rolname IN ('$app_user','$migrator_user','$readonly_user')")" == "0" ]] || {
    echo "$database changed restricted roles after failed ownership preflight" >&2
    return 1
  }
  run_psql "$database" postgres "$bootstrap_password" -c \
    "CREATE ROLE $app_user NOLOGIN; CREATE ROLE $migrator_user NOLOGIN; CREATE ROLE $readonly_user NOLOGIN; CREATE SCHEMA source_role_aux; GRANT CREATE ON SCHEMA source_role_aux TO $app_user, $migrator_user, $readonly_user; GRANT CREATE ON SCHEMA public TO $migrator_user; ALTER TABLE source_probe OWNER TO $migrator_user; CREATE SEQUENCE public.source_probe_seq; ALTER SEQUENCE public.source_probe_seq OWNER TO $migrator_user; GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.source_probe_seq TO PUBLIC; ALTER DEFAULT PRIVILEGES FOR ROLE $migrator_user GRANT INSERT, UPDATE, DELETE ON TABLES TO PUBLIC; ALTER DEFAULT PRIVILEGES FOR ROLE $migrator_user IN SCHEMA public GRANT INSERT, UPDATE, DELETE ON TABLES TO PUBLIC; ALTER DEFAULT PRIVILEGES FOR ROLE $migrator_user GRANT USAGE, UPDATE ON SEQUENCES TO PUBLIC; ALTER DEFAULT PRIVILEGES FOR ROLE $migrator_user IN SCHEMA public GRANT USAGE, UPDATE ON SEQUENCES TO PUBLIC" >/dev/null
  # Existing application types may have had PUBLIC USAGE revoked. The
  # provisioner must grant the exact type to runtime and read-only roles.
  run_psql "$database" postgres "$bootstrap_password" -c \
    "CREATE TYPE public.source_status AS ENUM ('new', 'complete'); ALTER TYPE public.source_status OWNER TO $migrator_user; REVOKE USAGE ON TYPE public.source_status FROM PUBLIC" >/dev/null

  # Converge once, then reintroduce stale direct, PUBLIC and global/schema defaults.
  run_provisioner >/dev/null
  run_psql "$database" postgres "$bootstrap_password" -c "
    GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.source_probe TO PUBLIC;
    GRANT TRUNCATE, REFERENCES, TRIGGER ON TABLE public.source_probe TO $app_user;
    GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.source_probe TO $readonly_user;
    GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.source_probe_seq TO PUBLIC;
    GRANT USAGE, UPDATE ON SEQUENCE public.source_probe_seq TO $readonly_user;
    ALTER DEFAULT PRIVILEGES FOR ROLE $migrator_user GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO PUBLIC, $app_user, $readonly_user;
    ALTER DEFAULT PRIVILEGES FOR ROLE $migrator_user GRANT USAGE, UPDATE ON SEQUENCES TO PUBLIC, $readonly_user;
    ALTER DEFAULT PRIVILEGES FOR ROLE $migrator_user GRANT EXECUTE ON FUNCTIONS TO PUBLIC, $app_user, $readonly_user;
    ALTER DEFAULT PRIVILEGES FOR ROLE $migrator_user IN SCHEMA public GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO PUBLIC, $app_user, $readonly_user;
    ALTER DEFAULT PRIVILEGES FOR ROLE $migrator_user IN SCHEMA public GRANT USAGE, UPDATE ON SEQUENCES TO PUBLIC, $readonly_user;
    ALTER DEFAULT PRIVILEGES FOR ROLE $migrator_user IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC, $app_user, $readonly_user;
  " >/dev/null
  run_provisioner >/dev/null

  # ALTER DEFAULT PRIVILEGES must also grant USAGE on future types created by
  # the migration role, without depending on PUBLIC's default type privileges.
  run_psql "$database" "$migrator_user" "$migrator_password" -c \
    "CREATE TYPE public.migration_probe_status AS ENUM ('pending', 'complete'); REVOKE USAGE ON TYPE public.migration_probe_status FROM PUBLIC" >/dev/null
  for role in "$app_user" "$readonly_user"; do
    for type_name in source_status migration_probe_status; do
      [[ "$(run_psql "$database" postgres "$bootstrap_password" -Atq -c \
        "SELECT has_type_privilege('$role', 'public.$type_name', 'USAGE')")" == "t" ]] || {
        echo "$role lacks USAGE on public.$type_name" >&2
        return 1
      }
    done
  done

  # New migration functions must not inherit PUBLIC EXECUTE; explicit grants remain possible.
  run_psql "$database" "$migrator_user" "$migrator_password" -c \
    "CREATE FUNCTION public.migration_private_fn() RETURNS integer LANGUAGE sql SECURITY DEFINER AS \$\$ SELECT 7 \$\$" >/dev/null
  run_psql "$database" postgres "$bootstrap_password" -c \
    "GRANT EXECUTE ON FUNCTION public.migration_private_fn() TO $readonly_user" >/dev/null
  run_provisioner >/dev/null
  [[ "$(run_psql "$database" postgres "$bootstrap_password" -Atq -c "SELECT has_function_privilege('$readonly_user','public.migration_private_fn()','EXECUTE')::text")" == "false" ]] || {
    echo "$readonly_user retained direct EXECUTE on a SECURITY DEFINER function after re-provisioning" >&2
    return 1
  }
  local function_password
  for restricted_user in "$app_user" "$readonly_user"; do
    case "$restricted_user" in
      "$app_user") function_password="$app_password" ;;
      *) function_password="$readonly_password" ;;
    esac
    if run_psql "$database" "$restricted_user" "$function_password" -c \
      "SELECT public.migration_private_fn()" >/dev/null 2>&1; then
      echo "$restricted_user unexpectedly executed a function without an explicit grant" >&2
      return 1
    fi
  done
  run_psql "$database" postgres "$bootstrap_password" -c \
    "GRANT EXECUTE ON FUNCTION public.migration_private_fn() TO $app_user" >/dev/null
  [[ "$(run_psql "$database" "$app_user" "$app_password" -Atq -c \
    "SELECT public.migration_private_fn()")" == "7" ]] || {
    echo "$app_user could not execute its explicitly granted function" >&2
    return 1
  }

  # The shell entrypoint must fail closed if invoked with any restricted login.
  for restricted_user in "$app_user" "$migrator_user" "$readonly_user"; do
    local restricted_password
    case "$restricted_user" in
      "$app_user") restricted_password="$app_password" ;;
      "$migrator_user") restricted_password="$migrator_password" ;;
      *) restricted_password="$readonly_password" ;;
    esac
    if docker exec \
      -e PGHOST=127.0.0.1 -e PGDATABASE="$database" \
      -e PGUSER="$restricted_user" -e PGPASSWORD="$restricted_password" \
      -e POSTGRES_APP_USER="$app_user" -e POSTGRES_APP_PASSWORD="$app_password" \
      -e POSTGRES_MIGRATOR_USER="$migrator_user" -e POSTGRES_MIGRATOR_PASSWORD="$migrator_password" \
      -e POSTGRES_READONLY_USER="$readonly_user" -e POSTGRES_READONLY_PASSWORD="$readonly_password" \
      "$container" /bin/sh /provision/run-readonly-role-provisioner.sh >/dev/null 2>&1; then
      echo "$restricted_user unexpectedly ran the privileged role provisioner" >&2
      return 1
    fi
  done

  # Exercise the real Memecoin SQL migration chain as the unprivileged
  # migrator. PostgreSQL 16 provides gen_random_uuid() in core, so no
  # database-level CREATE privilege or extension installation is required.
  if [[ "$database" == "memecoin_role_ci" ]]; then
    run_psql "$database" "$migrator_user" "$migrator_password" -c \
      "CREATE TABLE schema_migrations(filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())" >/dev/null
    for migration in "$repo_root"/memecoin-intelligence/db/migrations/*.sql; do
      filename="$(basename "$migration")"
      docker cp "$migration" "$container:/tmp/$filename" >/dev/null
      run_psql "$database" "$migrator_user" "$migrator_password" -1 -f "/tmp/$filename" >/dev/null
      run_psql "$database" "$migrator_user" "$migrator_password" -c \
        "INSERT INTO schema_migrations(filename) VALUES ('$filename')" >/dev/null
    done
    [[ "$(run_psql "$database" "$migrator_user" "$migrator_password" -Atq -c "SELECT gen_random_uuid() IS NOT NULL")" == "t" ]]
  fi

  public_create="$(run_psql "$database" postgres "$bootstrap_password" -Atq -c \
    "SELECT EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl WHERE n.nspname='public' AND acl.grantee=0 AND acl.privilege_type='CREATE')")"
  [[ "$public_create" == "f" ]] || {
    echo "$database retained PUBLIC CREATE on schema public" >&2
    return 1
  }

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
    "CREATE TABLE migration_probe(id bigserial PRIMARY KEY, value text); INSERT INTO migration_probe(value) VALUES ('migration'); ALTER TABLE migration_probe ADD COLUMN note text" >/dev/null
  run_psql "$database" "$app_user" "$app_password" -c \
    "INSERT INTO migration_probe(value) VALUES ('runtime'); UPDATE migration_probe SET note='ok' WHERE value='runtime'; DELETE FROM migration_probe WHERE value='runtime'" >/dev/null
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
      "SELECT count(*) FROM pg_auth_members m JOIN pg_roles member_role ON member_role.oid=m.member JOIN pg_roles granted_role ON granted_role.oid=m.roleid WHERE member_role.rolname='$role' OR granted_role.rolname='$role'")"
    [[ "$memberships" == "0" ]] || {
      echo "$role still has role memberships: $memberships" >&2
      return 1
    }
    local database_create schema_create
    database_create="$(run_psql "$database" postgres "$bootstrap_password" -Atq -c \
      "SELECT has_database_privilege('$role', current_database(), 'CREATE')::text")"
    [[ "$database_create" == "false" ]] || {
      echo "$role unexpectedly has database CREATE privilege" >&2
      return 1
    }
    schema_create="$(run_psql "$database" postgres "$bootstrap_password" -Atq -c \
      "SELECT has_schema_privilege('$role', 'public', 'CREATE')::text")"
    if [[ "$role" == "$migrator_user" ]]; then
      [[ "$schema_create" == "true" ]] || { echo "$role lacks schema CREATE" >&2; return 1; }
    else
      [[ "$schema_create" == "false" ]] || { echo "$role unexpectedly has schema CREATE" >&2; return 1; }
    fi
    [[ "$(run_psql "$database" postgres "$bootstrap_password" -Atq -c "SELECT has_schema_privilege('$role', 'source_role_aux', 'CREATE')::text")" == "false" ]] || {
      echo "$role unexpectedly has CREATE on source_role_aux" >&2
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
  readonly_sequence_writes="$(run_psql "$database" postgres "$bootstrap_password" -Atq -c "SELECT has_sequence_privilege('$readonly_user','public.source_probe_seq','USAGE')::text || '|' || has_sequence_privilege('$readonly_user','public.source_probe_seq','UPDATE')::text || '|' || has_sequence_privilege('$readonly_user','public.migration_probe_id_seq','USAGE')::text || '|' || has_sequence_privilege('$readonly_user','public.migration_probe_id_seq','UPDATE')::text")"
  [[ "$readonly_sequence_writes" == "false|false|false|false" ]] || {
    echo "$readonly_user has sequence write/use privileges: $readonly_sequence_writes" >&2
    return 1
  }
  [[ "$readonly_writes" == "false|false|false|false|false|false|false|false" ]] || {
    echo "$readonly_user has write privileges: $readonly_writes" >&2
    return 1
  }
  local app_elevated public_relation_acl_count
  app_elevated="$(run_psql "$database" postgres "$bootstrap_password" -Atq -c \
    "SELECT has_table_privilege('$app_user','source_probe','TRUNCATE')::text || '|' || has_table_privilege('$app_user','source_probe','REFERENCES')::text || '|' || has_table_privilege('$app_user','source_probe','TRIGGER')::text || '|' || has_table_privilege('$app_user','migration_probe','TRUNCATE')::text || '|' || has_table_privilege('$app_user','migration_probe','REFERENCES')::text || '|' || has_table_privilege('$app_user','migration_probe','TRIGGER')::text")"
  [[ "$app_elevated" == "false|false|false|false|false|false" ]] || {
    echo "$app_user retained elevated table ACLs: $app_elevated" >&2
    return 1
  }
  public_relation_acl_count="$(run_psql "$database" postgres "$bootstrap_password" -Atq -c \
    "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, '{}'::aclitem[])) acl WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S') AND acl.grantee=0")"
  [[ "$public_relation_acl_count" == "0" ]] || {
    echo "PUBLIC retained relation ACLs after re-provisioning: $public_relation_acl_count" >&2
    return 1
  }
  if run_psql "$database" "$readonly_user" "$readonly_password" -c \
    "SET default_transaction_read_only=off; INSERT INTO public.source_probe VALUES (3,'must-not-write')" >/dev/null 2>&1; then
    echo "$readonly_user bypassed read-only ACLs by changing default_transaction_read_only" >&2
    return 1
  fi
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
