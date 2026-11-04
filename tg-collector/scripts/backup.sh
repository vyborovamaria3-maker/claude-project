#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
# pg_dump/pg_restore from a newer major can emit restore commands unsupported
# by an older server (for example transaction_timeout on PostgreSQL 16).
source "$SCRIPT_DIR/postgres-client-compat.sh"
require_postgres_tool_matches_server "$DATABASE_URL" pg_dump
require_postgres_tool_matches_server "$DATABASE_URL" pg_restore

BACKUP_DIR="${TG_BACKUP_DIR:-./backups}"
RETENTION_DAYS="${TG_BACKUP_RETENTION_DAYS:-7}"
RCLONE_REMOTE="${TG_BACKUP_RCLONE_REMOTE:-}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/tg-collector-$stamp.dump"

echo "Creating PostgreSQL custom-format backup: $file"
pg_dump --dbname="$DATABASE_URL" --format=custom --file="$file"

pg_restore --list "$file" >/dev/null

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$file" > "$file.sha256"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$file" > "$file.sha256"
fi

if [[ -n "$RCLONE_REMOTE" ]]; then
  command -v rclone >/dev/null 2>&1 || {
    echo "TG_BACKUP_RCLONE_REMOTE is set but rclone is not installed" >&2
    exit 1
  }
  rclone copy "$file" "$RCLONE_REMOTE"
  [[ -f "$file.sha256" ]] && rclone copy "$file.sha256" "$RCLONE_REMOTE"
fi

find "$BACKUP_DIR" -type f -name 'tg-collector-*.dump*' -mtime +"$RETENTION_DAYS" -delete

echo "Backup complete and archive header verified."
