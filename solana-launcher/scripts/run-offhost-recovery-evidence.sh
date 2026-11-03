#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Operator-only, offline copy verification. NEVER downloads or decrypts
# secrets, connects to a service or changes any source database.
# This measures verification elapsed time, NOT end-to-end RTO or RPO.

usage() {
  cat <<'HELP'
Usage: bash run-offhost-recovery-evidence.sh \
  --backup-dir /isolated/plaintext-copy/backup-YYYYMMDD \
  --expected-manifest-sha256 <64hex-from-independent-offhost-register> \
  --evidence-dir /isolated/private-evidence \
  --code-sha <40hex-commit> \
  --ticket-id <approved-operator-ticket> \
  --confirm-isolated-offhost

Required: operator-approved ISOLATED host, independently verified encrypted
off-host source, already decrypted/staged private copy, no production mounts,
isolated Docker daemon, sufficient free space for two PostgreSQL restores
and large SQLite copies, and a trusted manifest digest NOT read from this
copy. This tool neither decrypts archives nor verifies encryption provenance.
Evidence records restore-VERIFICATION elapsed seconds, NOT RPO/RTO.
Never commit logs, backup files, environment files, or operator evidence.
HELP
}

backup_arg='' expected_sha='' evidence_arg='' code_sha='' ticket_id='' confirm=0
while (($#)); do
  case "$1" in
    --backup-dir|--expected-manifest-sha256|--evidence-dir|--code-sha|--ticket-id)
      (($# >= 2)) || { echo "Missing argument for $1" >&2; exit 2; }
      case "$1" in
        --backup-dir) backup_arg="$2";;
        --expected-manifest-sha256) expected_sha="$2";;
        --evidence-dir) evidence_arg="$2";;
        --code-sha) code_sha="$2";;
        --ticket-id) ticket_id="$2";;
      esac
      shift 2;;
    --confirm-isolated-offhost) confirm=1; shift;;
    --help|-h) usage; exit 0;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2;;
  esac
done

[[ "$confirm" == 1 ]] || { echo "Explicit offline operator acknowledgement required" >&2; exit 2; }
[[ "$expected_sha" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "Require independent 64-character manifest SHA256" >&2; exit 2; }
[[ "$code_sha" =~ ^[0-9a-fA-F]{40}$ ]] || { echo "Require exact 40-character reviewed code SHA" >&2; exit 2; }
[[ "$ticket_id" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{2,79}$ ]] || {
  echo "Require nonsecret operator ticket ID (3..80 safe characters)" >&2; exit 2;
}
# The supplied code SHA is evidence only if it matches the EXACT tracked
# checkout that supplies this wrapper, verifier and catalog SQL. Refuse an
# untracked or locally edited verifier: otherwise the operator could report
# a reviewed commit while executing a different safety implementation.
command -v git >/dev/null || { echo "Git is required to bind recovery evidence to reviewed code" >&2; exit 2; }
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
checkout_root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Recovery verifier must run from a reviewed Git checkout" >&2; exit 2;
}
[[ "$script_dir" == "$checkout_root/solana-launcher/scripts" ]] || {
  echo "Recovery verifier is not in the expected tracked checkout directory" >&2; exit 2;
}
actual_code_sha="$(git -C "$checkout_root" rev-parse --verify HEAD 2>/dev/null)" || {
  echo "Cannot determine the checked-out recovery code SHA" >&2; exit 2;
}
[[ "${actual_code_sha,,}" == "${code_sha,,}" ]] || {
  echo "Requested recovery code SHA does not match checked-out HEAD" >&2; exit 2;
}
reviewed_files=(
  solana-launcher/scripts/run-offhost-recovery-evidence.sh
  solana-launcher/scripts/verify-backup-restore.sh
  solana-launcher/scripts/postgres-role-restoration-fingerprint.sql
)
for reviewed_file in "${reviewed_files[@]}"; do
  git -C "$checkout_root" ls-files --error-unmatch -- "$reviewed_file" >/dev/null 2>&1 || {
    echo "Recovery verifier has an untracked required source file" >&2; exit 2;
  }
done
if ! git -C "$checkout_root" diff --quiet HEAD -- "${reviewed_files[@]}"; then
  echo "Recovery verifier source differs from reviewed Git HEAD" >&2
  exit 2
fi

[[ -d "$backup_arg" && ! -L "$backup_arg" && -f "$backup_arg/SHA256SUMS" && ! -L "$backup_arg/SHA256SUMS" ]] || {
  echo "Require existing regular backup and SHA256SUMS" >&2; exit 2;
}
[[ -d "$evidence_arg" && ! -L "$evidence_arg" ]] || {
  echo "Evidence directory must exist and not be a symlink" >&2; exit 2;
}
command -v sha256sum >/dev/null
command -v python3 >/dev/null
command -v docker >/dev/null
command -v stat >/dev/null
command -v id >/dev/null
backup="$(cd -- "$backup_arg" && pwd -P)"
evidence_dir="$(cd -- "$evidence_arg" && pwd -P)"

# Decrypted database archives and verifier logs contain sensitive schema and
# deployment metadata. Refuse group/world-accessible directories rather than
# relying on umask (which does not change permissions on existing directories).
require_private_owned_directory() {
  local directory="$1" label="$2" metadata owner mode
  metadata="$(stat -c '%u %a' -- "$directory")" || {
    echo "Cannot inspect $label directory ownership/permissions" >&2; exit 2;
  }
  read -r owner mode <<< "$metadata"
  [[ "$owner" == "$(id -u)" ]] || {
    echo "$label directory must be owned by the current operator" >&2; exit 2;
  }
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || {
    echo "Cannot parse $label directory permissions" >&2; exit 2;
  }
  if [[ "$mode" != "700" ]]; then
    echo "$label directory must have exact private mode 0700" >&2
    exit 2
  fi
}
require_private_owned_directory "$backup" "Backup"
require_private_owned_directory "$evidence_dir" "Evidence"

# Never run disposable restore containers through a remote Docker context:
# --network none prevents container egress, but does not make a remote daemon
# local or isolated. Honor Docker's context precedence over DOCKER_HOST.
if [[ -n "${DOCKER_CONTEXT:-}" ]]; then
  docker_context="$DOCKER_CONTEXT"
  docker_endpoint="$(docker context inspect "$docker_context" --format '{{(index .Endpoints "docker").Host}}' 2>/dev/null)" || {
    echo "Cannot inspect selected Docker context" >&2; exit 2;
  }
elif [[ -n "${DOCKER_HOST:-}" ]]; then
  docker_endpoint="$DOCKER_HOST"
else
  docker_context="$(docker context show 2>/dev/null)" || {
    echo "Cannot determine selected Docker context" >&2; exit 2;
  }
  docker_endpoint="$(docker context inspect "$docker_context" --format '{{(index .Endpoints "docker").Host}}' 2>/dev/null)" || {
    echo "Cannot inspect selected Docker context" >&2; exit 2;
  }
fi
case "$docker_endpoint" in
  unix://*) docker_endpoint_kind="unix" ;;
  npipe://*) docker_endpoint_kind="npipe" ;;
  *)
    echo "Offline recovery requires a local Docker endpoint (unix:// or npipe://); refusing remote daemon" >&2
    exit 2
    ;;
esac
[[ "$backup" != "$evidence_dir" && "$evidence_dir/" != "$backup/"* && "$backup/" != "$evidence_dir/"* ]] || {
  echo "Evidence and backup must use distinct non-nested directories" >&2; exit 2;
}
# Avoid running inadvertently against the usual production backup directory.
case "$backup" in
  /opt/potapoff-deploy|/opt/potapoff-deploy/*)
    echo "Refusing production deployment backup path: use an isolated off-host COPY" >&2; exit 2;;
esac

observed_sha="$(sha256sum -- "$backup/SHA256SUMS" | cut -d ' ' -f1)"
[[ "${observed_sha,,}" == "${expected_sha,,}" ]] || {
  echo "Independent backup manifest SHA256 mismatch; refusing restore" >&2; exit 1;
}
[[ -f "$backup/postgres.dump" && -f "$backup/admin-postgres.dump" &&
   -f "$backup/trade.db" && -f "$backup/intelligence.sqlite" ]] || {
  echo "Incomplete backed-up database set" >&2; exit 1;
}
# Data volume is intentionally reported in only aggregate bytes.
backup_bytes="$(du -sb -- "$backup" | cut -f1)"
evidence_free_bytes="$(df -PB1 "$evidence_dir" | awk 'NR==2 {print $4}')"
# Disk consumption depends on compressed DB size, SQLite copy and Docker's
# own storage partition; one free-space number is not a capacity guarantee.
echo "Operator capacity check: backup bytes=$backup_bytes; evidence-volume free bytes=$evidence_free_bytes" >&2
echo "Check Docker-root and temporary-volume free space separately before running." >&2

verifier="$script_dir/verify-backup-restore.sh"
[[ -r "$verifier" ]] || { echo "No reviewed offline verifier alongside this script" >&2; exit 1; }
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
started_epoch="$(date -u +%s)"
base="offline-recovery-${ticket_id}-${started_epoch}-$$"
log_path="$evidence_dir/$base.private.log"
json_path="$evidence_dir/$base.json"
# Persist the evidence record atomically and fail the command if a PASS
# cannot be durably represented. A successful restore without its evidence
# artifact must never be reported as a successful operator rehearsal.
finish() {
  local result="$?" evidence_status=0
  trap - EXIT
  set +e
  local ended_at elapsed result_name
  ended_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  elapsed="$(( $(date -u +%s) - started_epoch ))"
  if ((result == 0)); then result_name="PASS"; else result_name="FAIL"; fi
  EVIDENCE_RESULT="$result_name" EVIDENCE_EXIT="$result" \
  EVIDENCE_START="$started_at" EVIDENCE_END="$ended_at" EVIDENCE_ELAPSED="$elapsed" \
  EVIDENCE_SHA="$code_sha" EVIDENCE_MANIFEST_SHA="$observed_sha" \
  EVIDENCE_TICKET="$ticket_id" EVIDENCE_BYTES="$backup_bytes" \
  EVIDENCE_DOCKER_ENDPOINT_KIND="$docker_endpoint_kind" \
  EVIDENCE_LOG_NAME="$(basename "$log_path")" \
  python3 - "$json_path.tmp" <<'PY'
import json
import os
import sys
payload = {
    "scope": "isolated_operator_restoration_of_preexisting_backup_copy",
    "result": os.environ["EVIDENCE_RESULT"],
    "exit_code": int(os.environ["EVIDENCE_EXIT"]),
    "started_at_utc": os.environ["EVIDENCE_START"],
    "ended_at_utc": os.environ["EVIDENCE_END"],
    "verification_elapsed_seconds": int(os.environ["EVIDENCE_ELAPSED"]),
    "code_sha": os.environ["EVIDENCE_SHA"],
    "independent_sha256_of_sha256sums": os.environ["EVIDENCE_MANIFEST_SHA"],
    "operator_ticket_id": os.environ["EVIDENCE_TICKET"],
    "backup_bytes_aggregate": int(os.environ["EVIDENCE_BYTES"]),
    "docker_endpoint_kind": os.environ["EVIDENCE_DOCKER_ENDPOINT_KIND"],
    "private_log_basename": os.environ["EVIDENCE_LOG_NAME"],
    "rpo_status": "NOT_MEASURED",
    "rto_status": "NOT_MEASURED",
    "encryption_at_rest_status": "OPERATOR_EVIDENCE_REQUIRED",
    "source_database_writes": False,
    "production_host_isolation": "OPERATOR_ATTESTATION_REQUIRED",
    "approval_for_role_cutover": False
}
with open(sys.argv[1], "x", encoding="utf-8") as output:
    json.dump(payload, output, indent=2, sort_keys=True)
    output.write("\\n")
PY
  evidence_status=$?
  if ((evidence_status == 0)); then
    mv -T -- "$json_path.tmp" "$json_path"
    evidence_status=$?
  fi
  if ((evidence_status != 0)); then
    rm -f -- "$json_path.tmp"
    echo "Failed to persist offline recovery evidence; refusing success" >&2
    if ((result == 0)); then result=1; fi
  else
    echo "Offline restoration verification: $result_name; private evidence: $json_path" >&2
  fi
  exit "$result"
}


# The verifier launches only --network none disposable PG16/PG17 containers,
# verifies the canonical file manifest, owners, ACLs and SQLite snapshots.
# Redirect the full, potentially sensitive object-name output to a private log.
bash "$verifier" "$backup" > "$log_path" 2>&1 || exit $?
grep -Fxq 'BACKUP_RESTORE_REHEARSAL_OK no_live_database_access=true' "$log_path" || {
  echo "Offline verifier did not emit final success marker" >&2; exit 1;
}
