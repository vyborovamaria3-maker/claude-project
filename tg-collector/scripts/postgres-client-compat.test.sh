#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

cat > "$tmp/psql" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "${FAKE_SERVER_VERSION_NUM:-160015}"
MOCK
cat > "$tmp/pg_dump" <<'MOCK'
#!/usr/bin/env bash
printf 'pg_dump (PostgreSQL) %s\n' "${FAKE_PG_DUMP_VERSION:-16.15}"
MOCK
cat > "$tmp/pg_restore" <<'MOCK'
#!/usr/bin/env bash
case "$1" in
  --version)
    printf 'pg_restore (PostgreSQL) %s\n' "${FAKE_PG_RESTORE_VERSION:-16.15}"
    ;;
  --list)
    printf ';     Dumped from database version: %s (test build)\n' "${FAKE_ARCHIVE_VERSION:-16.15}"
    ;;
  *)
    echo "unexpected pg_restore arguments" >&2
    exit 2
    ;;
esac
MOCK
chmod +x "$tmp/psql" "$tmp/pg_dump" "$tmp/pg_restore"
export PATH="$tmp:$PATH"
source "$SCRIPT_DIR/postgres-client-compat.sh"
archive="$tmp/fixture.dump"
: > "$archive"

[[ "$(postgres_tool_major pg_dump)" == "16" ]]
[[ "$(postgres_server_major "postgresql://test")" == "16" ]]
require_postgres_tool_matches_server "postgresql://test" pg_dump
require_postgres_tool_matches_server "postgresql://test" pg_restore
require_archive_not_newer_than_target "$archive" "postgresql://test"

export FAKE_PG_DUMP_VERSION="17.5"
if require_postgres_tool_matches_server "postgresql://test" pg_dump 2>/dev/null; then
  echo "Expected a newer pg_dump client to be rejected for PostgreSQL 16" >&2
  exit 1
fi

export FAKE_PG_DUMP_VERSION="16.15"
export FAKE_ARCHIVE_VERSION="17.5"
if require_archive_not_newer_than_target "$archive" "postgresql://test" 2>/dev/null; then
  echo "Expected a PostgreSQL 17 archive to be rejected for a PostgreSQL 16 target" >&2
  exit 1
fi

export FAKE_SERVER_VERSION_NUM="170005"
export FAKE_PG_RESTORE_VERSION="17.5"
export FAKE_ARCHIVE_VERSION="16.15"
require_postgres_tool_matches_server "postgresql://test" pg_restore
require_archive_not_newer_than_target "$archive" "postgresql://test"

echo "PASS: PostgreSQL client/archive compatibility checks"
