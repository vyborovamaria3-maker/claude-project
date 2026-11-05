#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_DIR="${ADMIN_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
TEMPLATE="${RUNTIME_ENV_TEMPLATE:-$ADMIN_DIR/.env.runtime.example}"
SOURCE="$ADMIN_DIR/.env"
TARGET="$ADMIN_DIR/.env.runtime"

fail() { printf '[runtime-env] ERROR: %s\n' "$*" >&2; exit 1; }

[[ -r "$TEMPLATE" ]] || fail "missing runtime allowlist: $TEMPLATE"
[[ -r "$SOURCE" ]] || fail "missing Compose environment: $SOURCE"
grep -Eq '^[[:space:]]*ADMIN_INTELLIGENCE_POSTGRES_DSN=' "$TEMPLATE" || fail "runtime allowlist is missing ADMIN_INTELLIGENCE_POSTGRES_DSN"

tmp="$(mktemp "$ADMIN_DIR/.env.runtime.XXXXXX")"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

awk -F= '
  FNR == NR {
    if ($0 !~ /^[[:space:]]*#/ && index($0, "=")) {
      key = $1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (key != "") allowed[key] = 1
    }
    next
  }
  {
    key = $1
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
    if (key in allowed) print
  }
' "$TEMPLATE" "$SOURCE" > "$tmp"

[[ -s "$tmp" ]] || fail "runtime allowlist produced an empty environment"
chmod 0600 "$tmp"
mv -f "$tmp" "$TARGET"
trap - EXIT
printf '[runtime-env] generated allowlisted admin runtime environment (mode 0600)\n'
