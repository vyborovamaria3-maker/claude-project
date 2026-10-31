#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
scratch="$(mktemp -d)"
product="potapoff-ci-product-$$"
admin="potapoff-admin-postgres"
frontend="potapoff-ci-frontend-$$"

cleanup(){
  docker rm -f "$product" "$admin" "$frontend" >/dev/null 2>&1 || true
  rm -rf -- "$scratch"
}
trap cleanup EXIT

[[ -d "$root/solana-launcher/node_modules/better-sqlite3" ]] || {
  echo "Install solana-launcher dependencies before this rehearsal" >&2
  exit 1
}
mkdir -p "$scratch/deploy" "$scratch/admin" "$scratch/frontend-data" "$scratch/backups"
chmod 0777 "$scratch/frontend-data"

# This test-only frontend container mirrors the production /app/data mount and
# uses the exact locked better-sqlite3 package. It has no network and cannot
# reach any production resource.
docker run -d --rm --network none --user node --name "$frontend" \
  --label com.docker.compose.project=potapoff \
  --label com.docker.compose.service=frontend \
  -v "$scratch/frontend-data:/app/data" \
  -v "$scratch/backups:/backup" \
  -v "$root/solana-launcher/node_modules:/app/node_modules:ro" \
  -w /app node:20-bookworm-slim sleep infinity >/dev/null

# Keep a writer open with committed rows still in WAL. The production backup
# must capture these rows through SQLite Online Backup, not by copying trade.db.
docker exec -d "$frontend" node -e '
  const fs = require("node:fs");
  const Database = require("better-sqlite3");
  try {
    const db = new Database("/app/data/trade.db");
    db.pragma("journal_mode=WAL");
    db.pragma("wal_autocheckpoint=0");
    db.exec("CREATE TABLE backup_fixture(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
    db.prepare("INSERT INTO backup_fixture(id,payload) VALUES(1,?)").run("written-to-wal");
    fs.writeFileSync("/tmp/sqlite-fixture-ready", "ready");
    setInterval(() => { db.pragma("data_version"); }, 1000);
  } catch (error) {
    fs.writeFileSync("/tmp/sqlite-fixture-error", String(error && error.message || error));
    process.exit(1);
  }
'
ready=0
for i in $(seq 1 50); do
  if docker exec "$frontend" test -s /tmp/sqlite-fixture-ready >/dev/null 2>&1; then
    ready=1
    break
  fi
  if docker exec "$frontend" test -s /tmp/sqlite-fixture-error >/dev/null 2>&1; then
    docker exec "$frontend" cat /tmp/sqlite-fixture-error >&2
    exit 1
  fi
  sleep 0.1
done
[[ "$ready" = 1 ]] || {
  echo "SQLite WAL fixture did not become ready" >&2
  exit 1
}
docker exec "$frontend" test -s /app/data/trade.db-wal

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

# The role audit is observational and must parse on a disposable PostgreSQL DB.
docker exec -i "$product" psql -U potapoff -d potapoff -v ON_ERROR_STOP=1 -f - \
  < "$root/docs/operations/postgres-effective-privileges.sql" >/dev/null

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
[[ -s "$backup/trade.db" && -s "$backup/SHA256SUMS" && -r "$backup/admin-site/.env" ]]
grep -Fq "  ./trade.db" "$backup/SHA256SUMS"
[[ ! -e "$BACKUP_ROOT/.incomplete-" ]] || {
  echo "Incomplete backup was promoted" >&2; exit 1;
}

# Verify the row that was committed only to the WAL is present in the backup.
docker exec -e "BACKUP_SQLITE_PATH=/backup/$(basename "$backup")/trade.db" \
  "$frontend" node -e '
    const Database = require("better-sqlite3");
    const db = new Database(process.env.BACKUP_SQLITE_PATH, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT payload FROM backup_fixture WHERE id=1").get();
      if (!row || row.payload !== "written-to-wal") process.exit(1);
      console.log("SQLITE_WAL_ROW_RESTORED_OK");
    } finally {
      db.close();
    }
  ' | grep -Fq "SQLITE_WAL_ROW_RESTORED_OK"

bash "$root/solana-launcher/scripts/verify-backup-restore.sh" "$backup" |
  grep -Fq 'BACKUP_RESTORE_REHEARSAL_OK'
echo "SYNTHETIC_RESTORE_TEST_OK product_pg admin_pg sqlite_wal"

# Corruption of either database family must invalidate the whole recovery set.
cp "$backup/postgres.dump" "$scratch/postgres.dump.original"
printf 'corruption' >> "$backup/postgres.dump"
if bash "$root/solana-launcher/scripts/verify-backup-restore.sh" "$backup" >/dev/null 2>&1; then
  echo "Corrupted PostgreSQL backup passed restore gate" >&2
  exit 1
fi
mv "$scratch/postgres.dump.original" "$backup/postgres.dump"
echo "CORRUPTED_POSTGRES_BACKUP_REJECTED_OK"

cp "$backup/trade.db" "$scratch/trade.db.original"
printf 'corruption' >> "$backup/trade.db"
if bash "$root/solana-launcher/scripts/verify-backup-restore.sh" "$backup" >/dev/null 2>&1; then
  echo "Corrupted SQLite backup passed restore gate" >&2
  exit 1
fi
mv "$scratch/trade.db.original" "$backup/trade.db"
echo "CORRUPTED_SQLITE_BACKUP_REJECTED_OK"

# A symlink copied from a config source must not escape the checksum manifest.
mv "$scratch/admin/sources.json" "$scratch/admin/sources.json.original"
ln -s .env "$scratch/admin/sources.json"
sleep 1
if bash "$root/solana-launcher/scripts/backup-production.sh" >/dev/null 2>&1; then
  echo "Backup unexpectedly accepted a symlinked config file" >&2
  exit 1
fi
rm "$scratch/admin/sources.json"
mv "$scratch/admin/sources.json.original" "$scratch/admin/sources.json"
if find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.incomplete-*' -print -quit | grep -q .; then
  echo "Symlink rejection left an incomplete directory behind" >&2
  exit 1
fi
echo "SYMLINKED_BACKUP_SOURCE_REJECTED_OK"

# Missing frontend/SQLite source must fail closed and remove its incomplete set.
docker stop "$frontend" >/dev/null
sleep 1
if bash "$root/solana-launcher/scripts/backup-production.sh" >/dev/null 2>&1; then
  echo "Backup unexpectedly passed without the SQLite source container" >&2
  exit 1
fi
if find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.incomplete-*' -print -quit | grep -q .; then
  echo "Failed backup left an incomplete directory behind" >&2
  exit 1
fi
echo "MISSING_SQLITE_SOURCE_REJECTED_OK"
