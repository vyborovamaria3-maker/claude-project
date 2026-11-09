#!/usr/bin/env bash
set -Eeuo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
container="readonly-source-role-ci-${GITHUB_RUN_ID:-local}-$$"
bootstrap_password="ci-bootstrap-password"
readonly_password="ci-readonly-password"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$container" -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$bootstrap_password" -e POSTGRES_DB=postgres postgres:16-alpine >/dev/null
ready=false
for _ in $(seq 1 60); do
  # The official postgres image starts a temporary Unix-socket-only server
  # during initdb. A socket pg_isready can therefore succeed immediately
  # before that server is stopped. Wait for init completion AND verify that
  # the final TCP listener can execute a real query before using the DB.
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

test_role() {
  local database="$1" readonly_user="$2" sql_path="$3"
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -c "CREATE DATABASE $database" >/dev/null
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$database" -c "CREATE TABLE source_probe (id integer PRIMARY KEY, value text); INSERT INTO source_probe VALUES (1, 'visible');" >/dev/null
  docker cp "$repo_root/$sql_path" "$container:/tmp/provision-readonly-role.sql" >/dev/null
  for _ in 1 2; do
    docker exec -e PGHOST=127.0.0.1 -e PGUSER=postgres -e PGPASSWORD="$bootstrap_password" -e POSTGRES_READONLY_USER="$readonly_user" -e POSTGRES_READONLY_PASSWORD="$readonly_password" "$container" psql -X -v ON_ERROR_STOP=1 -d "$database" -f /tmp/provision-readonly-role.sql >/dev/null
  done
  local selected
  selected="$(docker exec -e PGHOST=127.0.0.1 -e PGPASSWORD="$readonly_password" "$container" psql -X -At -U "$readonly_user" -d "$database" -c "SELECT value FROM source_probe WHERE id = 1")"
  [[ "$selected" == "visible" ]] || { echo "$readonly_user cannot read an existing source table" >&2; return 1; }
  docker exec "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d "$database" -c "CREATE TABLE source_probe_after (id integer PRIMARY KEY); INSERT INTO source_probe_after VALUES (2);" >/dev/null
  docker exec -e PGHOST=127.0.0.1 -e PGPASSWORD="$readonly_password" "$container" psql -X -v ON_ERROR_STOP=1 -U "$readonly_user" -d "$database" -c "SELECT id FROM source_probe_after WHERE id = 2" >/dev/null
  local flags
  flags="$(docker exec "$container" psql -X -At -U postgres -d "$database" -c "SELECT rolsuper::text || '|' || rolcreatedb::text || '|' || rolcreaterole::text || '|' || rolreplication::text || '|' || rolbypassrls::text || '|' || rolinherit::text FROM pg_roles WHERE rolname = '$readonly_user'")"
  [[ "$flags" == "false|false|false|false|false|false" ]] || { echo "$readonly_user has unsafe role attributes: $flags" >&2; return 1; }
  local write_privileges
  write_privileges="$(docker exec "$container" psql -X -At -U postgres -d "$database" -c "SELECT has_table_privilege('$readonly_user', 'source_probe', 'INSERT')::text || '|' || has_table_privilege('$readonly_user', 'source_probe', 'UPDATE')::text || '|' || has_table_privilege('$readonly_user', 'source_probe', 'DELETE')::text || '|' || has_table_privilege('$readonly_user', 'source_probe', 'TRUNCATE')::text")"
  [[ "$write_privileges" == "false|false|false|false" ]] || { echo "$readonly_user has direct write privileges: $write_privileges" >&2; return 1; }
  local memberships
  memberships="$(docker exec "$container" psql -X -At -U postgres -d "$database" -c "SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = '$readonly_user'")"
  [[ "$memberships" == "0" ]] || { echo "$readonly_user still has role memberships: $memberships" >&2; return 1; }
  local read_only_setting
  read_only_setting="$(docker exec -e PGHOST=127.0.0.1 -e PGPASSWORD="$readonly_password" "$container" psql -X -At -U "$readonly_user" -d "$database" -c "SHOW default_transaction_read_only")"
  [[ "$read_only_setting" == "on" ]] || { echo "$readonly_user does not default to read-only transactions" >&2; return 1; }
  if docker exec -e PGHOST=127.0.0.1 -e PGPASSWORD="$readonly_password" "$container" psql -X -v ON_ERROR_STOP=1 -U "$readonly_user" -d "$database" -c "INSERT INTO source_probe VALUES (2, 'must-not-write')" >/dev/null 2>&1; then echo "$readonly_user unexpectedly inserted into a source table" >&2; return 1; fi
  if docker exec -e PGHOST=127.0.0.1 -e PGPASSWORD="$readonly_password" "$container" psql -X -v ON_ERROR_STOP=1 -U "$readonly_user" -d "$database" -c "SET ROLE postgres" >/dev/null 2>&1; then echo "$readonly_user unexpectedly escalated to the bootstrap role" >&2; return 1; fi
}
test_role "solsub_role_ci" "solsub_readonly" "solana-subscription-service/scripts/provision-readonly-role.sql"
test_role "memecoin_role_ci" "memecoin_readonly" "memecoin-intelligence/scripts/provision-readonly-role.sql"
echo "PostgreSQL source roles are SELECT-only, non-escalatable and idempotent."
