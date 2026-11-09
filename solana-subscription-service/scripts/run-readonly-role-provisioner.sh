#!/bin/sh
set -eu

: "${PGHOST:?PGHOST is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${POSTGRES_APP_USER:?POSTGRES_APP_USER is required}"
: "${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD is required}"
: "${POSTGRES_MIGRATOR_USER:?POSTGRES_MIGRATOR_USER is required}"
: "${POSTGRES_MIGRATOR_PASSWORD:?POSTGRES_MIGRATOR_PASSWORD is required}"
: "${POSTGRES_READONLY_USER:?POSTGRES_READONLY_USER is required}"
: "${POSTGRES_READONLY_PASSWORD:?POSTGRES_READONLY_PASSWORD is required}"

if [ "$POSTGRES_APP_USER" = "$POSTGRES_MIGRATOR_USER" ] ||
   [ "$POSTGRES_APP_USER" = "$POSTGRES_READONLY_USER" ] ||
   [ "$POSTGRES_MIGRATOR_USER" = "$POSTGRES_READONLY_USER" ]; then
  printf '%s\n' 'Application, migration and read-only roles must be distinct' >&2
  exit 64
fi

if [ "$PGUSER" = "$POSTGRES_APP_USER" ] ||
   [ "$PGUSER" = "$POSTGRES_MIGRATOR_USER" ] ||
   [ "$PGUSER" = "$POSTGRES_READONLY_USER" ]; then
  printf '%s\n' 'Refusing to provision roles while connected as a restricted role' >&2
  exit 64
fi

exec psql -X -v ON_ERROR_STOP=1 -f /provision/readonly-role.sql
