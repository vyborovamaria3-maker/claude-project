#!/usr/bin/env bash
# Track the last successfully deployed source commit independently of the checkout being deployed.

resolve_previous_deployed_sha() {
  local repo_dir="$1" marker_file="$2" override="${3:-}" marker_sha="" previous_sha=""
  if [[ -e "$marker_file" ]]; then
    [[ -r "$marker_file" ]] || { printf "Deployment SHA marker is not readable: %s\n" "$marker_file" >&2; return 1; }
    marker_sha="$(tr -d '[:space:]' < "$marker_file")"
    [[ "$marker_sha" =~ ^[0-9a-fA-F]{40}$ ]] || { printf "Deployment SHA marker is invalid: %s\n" "$marker_file" >&2; return 1; }
  fi
  if [[ -n "$override" ]]; then
    [[ "$override" =~ ^[0-9a-fA-F]{40}$ ]] || { printf "PREVIOUS_GIT_SHA must be a full 40-character commit SHA\n" >&2; return 1; }
    if [[ -n "$marker_sha" && "${marker_sha,,}" != "${override,,}" ]]; then
      printf "PREVIOUS_GIT_SHA does not match the recorded deployed SHA marker\n" >&2
      return 1
    fi
    previous_sha="${override,,}"
  else
    previous_sha="${marker_sha,,}"
  fi
  if [[ -z "$previous_sha" ]]; then
    if command -v docker >/dev/null 2>&1 && { docker inspect potapoff-admin >/dev/null 2>&1 || docker inspect potapoff-intelligence >/dev/null 2>&1; }; then
      printf "An existing deployment is present but its Git SHA is unknown; set PREVIOUS_GIT_SHA to the currently deployed commit\n" >&2
      return 1
    fi
    return 0
  fi
  git -C "$repo_dir" cat-file -e "${previous_sha}^{commit}" >/dev/null 2>&1 || {
    printf "Previously deployed commit is not available in the local repository: %s\n" "$previous_sha" >&2
    return 1
  }
  printf "%s\n" "$previous_sha"
}

write_deployed_sha() {
  local repo_dir="$1" marker_file="$2" current_sha marker_dir tmp
  current_sha="$(git -C "$repo_dir" rev-parse --verify HEAD)" || return 1
  [[ "$current_sha" =~ ^[0-9a-fA-F]{40}$ ]] || { printf "Current checkout does not resolve to a full commit SHA\n" >&2; return 1; }
  marker_dir="$(dirname -- "$marker_file")"
  install -d -m 0700 "$marker_dir" || return 1
  tmp="$(mktemp "${marker_file}.XXXXXX")" || return 1
  if ! printf "%s\n" "$current_sha" > "$tmp" || ! chmod 0600 "$tmp" || ! mv -f -- "$tmp" "$marker_file"; then
    rm -f -- "$tmp"
    return 1
  fi
  printf "%s\n" "$current_sha"
}
