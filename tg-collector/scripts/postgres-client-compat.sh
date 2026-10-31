#!/usr/bin/env bash
# Shared version checks for PostgreSQL custom-format backup/restore scripts.

postgres_tool_major() {
  local tool="$1" version
  version="$("$tool" --version 2>/dev/null)" || {
    echo "Cannot execute $tool --version" >&2
    return 1
  }
  if [[ "$version" =~ \)[[:space:]]([0-9]+)(\.|[[:space:]]|$) ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi
  echo "Cannot parse PostgreSQL client version from: $version" >&2
  return 1
}

postgres_server_major() {
  local database_url="$1" version_num
  version_num="$(psql -X -v ON_ERROR_STOP=1 -Atc 'SHOW server_version_num' "$database_url")" || return 1
  if [[ ! "$version_num" =~ ^[0-9]+$ ]]; then
    echo "Cannot parse PostgreSQL server_version_num: $version_num" >&2
    return 1
  fi
  printf '%s\n' "$((version_num / 10000))"
}

require_postgres_tool_matches_server() {
  local database_url="$1" tool="$2" client_major server_major
  server_major="$(postgres_server_major "$database_url")" || return 1
  client_major="$(postgres_tool_major "$tool")" || return 1
  if [[ "$client_major" != "$server_major" ]]; then
    echo "PostgreSQL version mismatch: $tool client is major $client_major but the database server is major $server_major." >&2
    echo "Install PostgreSQL $server_major client tools before creating or restoring this backup." >&2
    return 1
  fi
}

archive_dump_server_major() {
  local archive="$1" toc major
  toc="$(pg_restore --list "$archive")" || return 1
  major="$(printf '%s\n' "$toc" | awk -F: '
    /^;[[:space:]]*Dumped from database version:/ {
      split($2, parts, ".")
      gsub(/[^0-9]/, "", parts[1])
      print parts[1]
      exit
    }')"
  if [[ ! "$major" =~ ^[0-9]+$ ]]; then
    echo "Cannot determine source PostgreSQL major version from archive header: $archive" >&2
    return 1
  fi
  printf '%s\n' "$major"
}

require_archive_not_newer_than_target() {
  local archive="$1" database_url="$2" archive_major target_major
  archive_major="$(archive_dump_server_major "$archive")" || return 1
  target_major="$(postgres_server_major "$database_url")" || return 1
  if (( archive_major > target_major )); then
    echo "PostgreSQL archive is from major $archive_major but the restore target is major $target_major." >&2
    echo "Restore PostgreSQL archives only to the same or a newer server major version." >&2
    return 1
  fi
}
