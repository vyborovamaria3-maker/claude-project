#!/usr/bin/env bash
# Validate provisioner SQL sources on the host BEFORE they are docker-cp'ed
# into a disposable PostgreSQL container. Inside the CI containers these files
# live under /tmp or /provision, paths that do not exist on the runner host,
# so a host-side grep against container paths would fail silently inside an
# if-condition and the delimiter check would never run.
set -Eeuo pipefail

status=0
for sql_file in "$@"; do
  if [[ ! -f "$sql_file" ]]; then
    echo "SQL provisioner file is missing: $sql_file" >&2
    status=1
    continue
  fi
  if grep -Eq '^[[:space:]]*DO[[:space:]]+\$[[:space:]]*$|^[[:space:]]*\$;[[:space:]]*$' "$sql_file"; then
    echo "Malformed DO dollar-quote delimiter in $sql_file" >&2
    status=1
  fi
done
exit "$status"
