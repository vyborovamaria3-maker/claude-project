#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${POSTGRES_BOOTSTRAP_USER:?POSTGRES_BOOTSTRAP_USER is required}"
: "${POSTGRES_BOOTSTRAP_PASSWORD:?POSTGRES_BOOTSTRAP_PASSWORD is required}"
: "${POSTGRES_MIGRATOR_USER:?POSTGRES_MIGRATOR_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"

bootstrap_user=$POSTGRES_BOOTSTRAP_USER
bootstrap_password=$POSTGRES_BOOTSTRAP_PASSWORD
migrator_user=$POSTGRES_MIGRATOR_USER
db_name=$POSTGRES_DB
pg_host=${PGHOST:-postgres}
pg_port=${PGPORT:-5432}
unset POSTGRES_BOOTSTRAP_USER POSTGRES_BOOTSTRAP_PASSWORD

granted=0
run_psql() {
  PGPASSWORD="$bootstrap_password" psql -X -v ON_ERROR_STOP=1 \
    -h "$pg_host" -p "$pg_port" -U "$bootstrap_user" -d "$db_name" \
    -v dbname="$db_name" -v migrator="$migrator_user" "$@"
}
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$granted" -eq 1 ]; then
    if ! run_psql -c 'REVOKE CREATE ON DATABASE :"dbname" FROM :"migrator";'; then
      printf '%s\n' "ERROR: could not revoke temporary database CREATE from migrator" >&2
      [ "$status" -ne 0 ] || status=1
    fi
    granted=0
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The immutable Prisma baseline contains CREATE SCHEMA IF NOT EXISTS public.
# PostgreSQL checks database CREATE even if public already exists. Grant it
# only for migration deploy, then revoke before running the seed.
run_psql -c 'GRANT CREATE ON DATABASE :"dbname" TO :"migrator";'
granted=1
npm run prisma:deploy -w @solsub/api
run_psql -c 'REVOKE CREATE ON DATABASE :"dbname" FROM :"migrator";'
granted=0
trap - EXIT INT TERM
npm run prisma:seed -w @solsub/api
