#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
scratch="$(mktemp -d)"
product="potapoff-ci-product-$$"
admin="potapoff-admin-postgres"
cleanup(){
  docker rm -f "$product" "$admin" >/dev/null 2>&1 || true
  rm -rf -- "$scratch"
}
trap cleanup EXIT
# These are disposable test-only PostgreSQL containers; no live host is used.
docker run -d --rm --network none --name "$product" \
  --label com.docker.compose.project=potapoff \
  --label com.docker.compose.service=postgres \
  -e POSTGRES_USER=potapoff -e POSTGRES_DB=potapoff \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine >/dev/null
docker run -d --rm --network none --name "$admin" \
  -e POSTGRES_USER=potapoff_admin -e POSTGRES_DB=potapoff_admin \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine >/dev/null
ready=0
for i in $(seq 1 45); do
  # Avoid a false positive during Docker entrypoint's bootstrap PostgreSQL
  # server; it is intentionally stopped before the final server starts.
  if docker logs "$product" 2>&1 | grep -Fq 'PostgreSQL init process complete; ready for start up.' &&
     docker logs "$admin" 2>&1 | grep -Fq 'PostgreSQL init process complete; ready for start up.' &&
     docker exec "$product" pg_isready -U potapoff >/dev/null 2>&1 &&
     docker exec "$admin" pg_isready -U potapoff_admin >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" = 1 ]] || { echo "Synthetic DBs failed to initialize" >&2; exit 1; }

docker exec "$product" psql -U potapoff -d potapoff -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE synthetic_product(id integer primary key, tag text); INSERT INTO synthetic_product VALUES (1,'safe-fixture');" >/dev/null
docker exec "$admin" psql -U potapoff_admin -d potapoff_admin -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE synthetic_admin(id integer primary key, tag text); INSERT INTO synthetic_admin VALUES (2,'safe-fixture');" >/dev/null

mkdir -p "$scratch/deploy" "$scratch/admin"
printf 'POSTGRES_PASSWORD=ci-synthetic\n' > "$scratch/deploy/.env.server"
printf 'TEST_ONLY=1\n' > "$scratch/deploy/backend.env"
printf 'services: {}\n' > "$scratch/deploy/docker-compose.production.yml"
printf 'ci-image-tag\n' > "$scratch/deploy/.current-image-tag"
printf 'ADMIN_ENVIRONMENT=test\n' > "$scratch/admin/.env"
printf 'POTAPOFF_INTELLIGENCE_BACKEND=test\n' > "$scratch/admin/.env.intelligence"
printf '{}\n' > "$scratch/admin/sources.json"
printf '[]\n' > "$scratch/admin/logs.json"

export DEPLOY_DIR="$scratch/deploy"
export BACKUP_ROOT="$scratch/backups"
export ADMIN_DIR="$scratch/admin"
backup="$(bash "$root/solana-launcher/scripts/backup-production.sh")"
[[ -s "$backup/postgres.dump" && -s "$backup/admin-postgres.dump" ]]
[[ -s "$backup/SHA256SUMS" && -r "$backup/admin-site/.env" ]]
[[ ! -e "$BACKUP_ROOT/.incomplete-" ]] || {
  echo "Incomplete backup was promoted" >&2; exit 1;
}
bash "$root/solana-launcher/scripts/verify-backup-restore.sh" "$backup" |
  grep -Fq 'BACKUP_RESTORE_REHEARSAL_OK'
echo "SYNTHETIC_RESTORE_TEST_OK both_databases"

# Mutation must invalidate checksums before any database is restored.
printf 'corruption' >> "$backup/postgres.dump"
if bash "$root/solana-launcher/scripts/verify-backup-restore.sh" "$backup" >/dev/null 2>&1; then
  echo "Corrupted database backup passed restore gate" >&2
  exit 1
fi
echo "CORRUPTED_BACKUP_REJECTED_OK"
