#!/bin/sh
set -eu

: "${PGHOST:?PGHOST is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${POSTGRES_READONLY_USER:?POSTGRES_READONLY_USER is required}"
: "${POSTGRES_READONLY_PASSWORD:?POSTGRES_READONLY_PASSWORD is required}"

if [ "$PGUSER" = "$POSTGRES_READONLY_USER" ]; then
  printf '%s\n' 'Refusing to provision a read-only role while connected as that role' >&2
  exit 64
fi

exec psql -X -v ON_ERROR_STOP=1 -f /provision/readonly-role.sql
