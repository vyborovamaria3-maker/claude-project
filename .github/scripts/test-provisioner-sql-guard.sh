#!/usr/bin/env bash
# Regression test for the provisioner SQL delimiter guard.
#
# Guards against two classes of CI escape:
#   1. The check being executed against a path that only exists inside a
#      container (grep "No such file or directory" silently ignored inside an
#      if-condition), which means the check never runs.
#   2. A malformed DO dollar-quote delimiter slipping into provisioner SQL.
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
guard="$root/.github/scripts/check-provisioner-sql-delimiters.sh"
scratch="$(mktemp -d)"
cleanup() { rm -rf "$scratch"; }
trap cleanup EXIT

fail() { echo "GUARD REGRESSION FAIL: $1" >&2; exit 1; }

# 1. A missing file must be an error, never a silent pass.
if bash "$guard" "$scratch/does-not-exist.sql" >"$scratch/missing.log" 2>&1; then
  fail "missing file was accepted"
fi
grep -q "SQL provisioner file is missing" "$scratch/missing.log" || {
  fail "missing-file diagnostic was not produced"
}

# 2. A malformed DO dollar-quote delimiter must be rejected.
printf 'DO $\nBEGIN\n  RAISE EXCEPTION;\nEND\n$;\n' > "$scratch/malformed.sql"
if bash "$guard" "$scratch/malformed.sql" >"$scratch/malformed.log" 2>&1; then
  fail "malformed delimiter was accepted"
fi
grep -q "Malformed DO dollar-quote delimiter" "$scratch/malformed.log" || {
  fail "malformed-delimiter diagnostic was not produced"
}

# 3. Correct provisioner SQL must pass, proving the guard actually inspects
#    content and is not failing closed or skipping reads.
printf '\\set ON_ERROR_STOP on\nDO $$\nBEGIN\n  RAISE EXCEPTION;\nEND\n$$;\n' > "$scratch/clean.sql"
bash "$guard" "$scratch/clean.sql" || fail "clean SQL was rejected"

# 4. The real repository provisioner SQL files must pass the guard.
bash "$guard" \
  "$root/solana-launcher/scripts/provision-postgres-roles.sql" \
  "$root/solana-launcher/scripts/check-postgres-migrator-ownership.sql" \
  || fail "repository provisioner SQL rejected by guard"

# 5. The guard must fail when any listed file is missing, even alongside a
#    valid one (a skipped missing entry would weaken deployment validation).
if bash "$guard" "$scratch/clean.sql" "$scratch/gone.sql" >"$scratch/mixed.log" 2>&1; then
  fail "guard passed with one missing file in the list"
fi

echo "PROVISIONER_SQL_GUARD_TEST_OK missing_file=error malformed_delimiter=error clean_sql=pass"
