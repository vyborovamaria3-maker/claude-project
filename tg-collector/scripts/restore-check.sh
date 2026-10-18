#!/usr/bin/env bash
set -euo pipefail

archive="${1:?usage: restore-check.sh /path/to/tg-collector-YYYYMMDDTHHMMSSZ.dump}"
[[ -f "$archive" ]] || { echo "Archive not found: $archive" >&2; exit 1; }
: "${TG_RESTORE_CHECK_DATABASE_URL:?Set TG_RESTORE_CHECK_DATABASE_URL to an EMPTY disposable PostgreSQL database. This script restores into it.}"

pg_restore --list "$archive" >/dev/null
existing_objects="$(psql "$TG_RESTORE_CHECK_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc \
  "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace \
   WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND c.relkind IN ('r','p','v','m','S')")"
if [[ "$existing_objects" != "0" ]]; then
  echo "Restore target is not empty ($existing_objects user objects). Use a fresh disposable database." >&2
  exit 1
fi

echo "Restoring into the explicitly configured disposable database..."
pg_restore --dbname="$TG_RESTORE_CHECK_DATABASE_URL" --no-owner --no-privileges --exit-on-error --single-transaction "$archive"

echo "Restored key-table counts:"
psql "$TG_RESTORE_CHECK_DATABASE_URL" -v ON_ERROR_STOP=1 -P pager=off -c \
  "SELECT 'tg_sources' AS table_name,count(*) AS row_count FROM tg_sources
   UNION ALL SELECT 'tg_messages',count(*) FROM tg_messages
   UNION ALL SELECT 'tg_message_links',count(*) FROM tg_message_links
   UNION ALL SELECT 'tg_token_candidates',count(*) FROM tg_token_candidates
   UNION ALL SELECT 'tg_tokens',count(*) FROM tg_tokens
   UNION ALL SELECT 'tg_token_mentions',count(*) FROM tg_token_mentions
   UNION ALL SELECT 'tg_graph_daily_edges',count(*) FROM tg_graph_daily_edges"

echo "PASS: archive restored successfully. The disposable target now contains restored data; drop/recreate it before another run."
