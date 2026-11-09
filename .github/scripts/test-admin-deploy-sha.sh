#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
source "$ROOT/admin-site/deploy/deployed-sha.sh"
SCRATCH="$(mktemp -d)"
trap 'rm -rf -- "$SCRATCH"' EXIT
REPO="$SCRATCH/repo"
mkdir -p "$REPO" "$SCRATCH/bin"
git init -q "$REPO"
git -C "$REPO" config user.name "Deploy SHA Test"
git -C "$REPO" config user.email "deploy-sha-test@example.invalid"
printf "first\n" > "$REPO/state.txt"
git -C "$REPO" add state.txt
git -C "$REPO" commit -qm "previous deployment"
PREVIOUS_SHA="$(git -C "$REPO" rev-parse HEAD)"
printf "second\n" > "$REPO/state.txt"
git -C "$REPO" commit -qam "target deployment"
TARGET_SHA="$(git -C "$REPO" rev-parse HEAD)"
MARKER="$SCRATCH/DEPLOYED_GIT_SHA"

cat > "$SCRATCH/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
if [[ "${DOCKER_INSPECT_PRESENT:-0}" == "1" && "$1" == "inspect" && ( "$2" == "potapoff-admin" || "$2" == "potapoff-intelligence" ) ]]; then
  exit 0
fi
exit 1
DOCKER
chmod 0700 "$SCRATCH/bin/docker"
export PATH="$SCRATCH/bin:$PATH"

printf "%s\n" "$PREVIOUS_SHA" > "$MARKER"
[[ "$(resolve_previous_deployed_sha "$REPO" "$MARKER" "")" == "$PREVIOUS_SHA" ]]
[[ "$(resolve_previous_deployed_sha "$REPO" "$MARKER" "$PREVIOUS_SHA")" == "$PREVIOUS_SHA" ]]
if resolve_previous_deployed_sha "$REPO" "$MARKER" "$TARGET_SHA" >/dev/null 2>&1; then
  echo "Mismatched PREVIOUS_GIT_SHA override was accepted" >&2
  exit 1
fi

rm -f -- "$MARKER"
[[ -z "$(resolve_previous_deployed_sha "$REPO" "$MARKER" "")" ]]
export DOCKER_INSPECT_PRESENT=1
if resolve_previous_deployed_sha "$REPO" "$MARKER" "" >/dev/null 2>&1; then
  echo "Existing deployment without a marker was accepted" >&2
  exit 1
fi
[[ "$(resolve_previous_deployed_sha "$REPO" "$MARKER" "$PREVIOUS_SHA")" == "$PREVIOUS_SHA" ]]
unset DOCKER_INSPECT_PRESENT

printf "not-a-commit\n" > "$MARKER"
if resolve_previous_deployed_sha "$REPO" "$MARKER" "" >/dev/null 2>&1; then
  echo "Invalid deployment marker was accepted" >&2
  exit 1
fi
rm -f -- "$MARKER"

[[ "$(write_deployed_sha "$REPO" "$MARKER")" == "$TARGET_SHA" ]]
[[ "$(tr -d '[:space:]' < "$MARKER")" == "$TARGET_SHA" ]]
[[ "$(stat -c "%a" "$MARKER")" == "600" ]]
echo "ADMIN_DEPLOY_SHA_TRACKING_OK"
