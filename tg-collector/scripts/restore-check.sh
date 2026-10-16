#!/usr/bin/env bash
set -euo pipefail

archive="${1:?usage: restore-check.sh /path/to/tg-collector-YYYYMMDDTHHMMSSZ.dump}"
[[ -f "$archive" ]] || { echo "Archive not found: $archive" >&2; exit 1; }

pg_restore --list "$archive" >/dev/null
echo "PASS: pg_restore can read archive: $archive"
echo "This check is non-destructive. Full restore verification must target a disposable PostgreSQL database."
