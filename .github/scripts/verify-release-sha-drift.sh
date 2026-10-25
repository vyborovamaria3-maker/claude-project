#!/usr/bin/env bash
set -Eeuo pipefail

# Verify SHA-locked production releases against the latest remote main.
# Re-run immediately before deployment to fence late runtime commits.
release_sha="${1:?usage: verify-release-sha-drift.sh RELEASE_SHA EVENT_SHA MODE}"
event_sha="${2:?missing EVENT_SHA}"
mode="${3:?mode must be exact or docs-only}"

if [[ ! "$release_sha" =~ ^[a-f0-9]{40}$ || ! "$event_sha" =~ ^[a-f0-9]{40}$ ]]; then
  echo 'Invalid release or event SHA' >&2
  exit 2
fi
if [[ "$mode" != exact && "$mode" != docs-only ]]; then
  echo 'Invalid release drift policy' >&2
  exit 2
fi
if [[ "${GITHUB_REF:-refs/heads/main}" != "refs/heads/main" ]]; then
  echo 'Release validation must run on main' >&2
  exit 1
fi

# Read the live remote main rather than trusting stale workflow_run GITHUB_SHA.
git fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/main' >/dev/null
remote_main="$(git rev-parse --verify 'refs/remotes/origin/main^{commit}')"
git cat-file -e "${release_sha}^{commit}"
git cat-file -e "${event_sha}^{commit}"

if ! git merge-base --is-ancestor "$event_sha" "$remote_main" ||
   ! git merge-base --is-ancestor "$release_sha" "$event_sha" ||
   ! git merge-base --is-ancestor "$release_sha" "$remote_main"; then
  echo 'Release SHA, event SHA and remote main are not an ordered ancestry' >&2
  exit 1
fi

if [[ "$mode" == exact ]]; then
  if [[ "$release_sha" != "$event_sha" || "$release_sha" != "$remote_main" ]]; then
    echo 'Manual deployment requires release SHA == event SHA == remote main' >&2
    exit 1
  fi
elif [[ "$remote_main" != "$release_sha" ]]; then
  # Disable rename detection: a runtime-to-docs move must expose both
  # the deleted runtime path and the added docs path, not only the latter.
  # Materialize the diff so git failures cannot be masked by process substitution.
  diff_names="$(mktemp)"
  trap 'rm -f "$diff_names"' EXIT
  if ! git diff --no-renames --name-only -z "$release_sha" "$remote_main" -- > "$diff_names"; then
    echo 'Unable to verify release file changes' >&2
    exit 1
  fi
  while IFS= read -r -d '' path; do
    case "$path" in
      docs/*|*.md|*.mdx) ;;
      *)
        echo "Refusing release: non-documentation drift after image build" >&2
        exit 1
        ;;
    esac
  done < "$diff_names"
  rm -f "$diff_names"
  trap - EXIT
fi

echo "RELEASE_SHA_OK release=$release_sha event=$event_sha remote_main=$remote_main mode=$mode"
