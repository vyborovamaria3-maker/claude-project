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
grant_db_create() {
  run_psql <<'SQL'
GRANT CREATE ON DATABASE :"dbname" TO :"migrator";
SQL
}
revoke_db_create() {
  run_psql <<'SQL'
REVOKE CREATE ON DATABASE :"dbname" FROM :"migrator";
SQL
}
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$granted" -eq 1 ]; then
    if ! revoke_db_create; then
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

# Only the immutable initial migration contains CREATE SCHEMA. Existing
# databases whose baseline is already recorded need no database-level grant.
migration_table_exists=$(run_psql -tA -c "SELECT to_regclass('public.\"_prisma_migrations\"') IS NOT NULL;")
case "$migration_table_exists" in
  t)
    baseline_applied=$(run_psql -tA -c "SELECT EXISTS (SELECT 1 FROM public.\"_prisma_migrations\" WHERE migration_name='20260627143000_init' AND finished_at IS NOT NULL AND rolled_back_at IS NULL);")
    ;;
  f)
    baseline_applied=f
    ;;
  *)
    printf '%s\\n' "ERROR: could not determine Prisma migration history state" >&2
    exit 1
    ;;
esac

case "$baseline_applied" in
  t)
    ;;
  f)
    # Set the cleanup guard before GRANT: if the connection drops after the
    # server commits the privilege but before psql reports success, EXIT still
    # attempts the REVOKE.
    granted=1
    grant_db_create
    ;;
  *)
    printf '%s\\n' "ERROR: invalid Prisma baseline state" >&2
    exit 1
    ;;
esac

npm run prisma:deploy -w @solsub/api
if [ "$granted" -eq 1 ]; then
  revoke_db_create
  granted=0
fi
trap - EXIT INT TERM
npm run prisma:seed -w @solsub/api
