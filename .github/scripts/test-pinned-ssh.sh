#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
mkdir -p "$scratch/home"
ssh-keygen -q -t ed25519 -N '' -f "$scratch/host_test" >/dev/null
key="$(awk '{print $2}' "$scratch/host_test.pub")"
fingerprint="$(ssh-keygen -lf "$scratch/host_test.pub" -E sha256 | awk '{print $2}')"
export HOME="$scratch/home"
export SERVER_HOST="example.invalid"
export SERVER_PORT="2222"
export SERVER_USER="deploy"
export SERVER_SSH_KEY="$(cat "$scratch/host_test")"
export SERVER_SSH_KNOWN_HOSTS="[$SERVER_HOST]:$SERVER_PORT ssh-ed25519 $key"
export SERVER_SSH_HOST_KEY_SHA256="$fingerprint"

# Valid out-of-band pin: only reads configuration; no network is used.
bash "$root/.github/scripts/prepare-pinned-ssh.sh" >/dev/null
# Validate the exact host-scoped policy written by the helper. Parsing via
# ssh -G is implementation-dependent and its boolean rendering varies.
grep -Fq 'StrictHostKeyChecking yes' "$HOME/.ssh/config"
grep -Fq 'UpdateHostKeys no' "$HOME/.ssh/config"
grep -Fq 'BatchMode yes' "$HOME/.ssh/config"
grep -Fq 'ForwardAgent no' "$HOME/.ssh/config"
ssh-keygen -F "[$SERVER_HOST]:$SERVER_PORT" -f "$HOME/.ssh/known_hosts" >/dev/null
echo "PINNED_SSH_TEST_OK positive_host_port_fingerprint"

# Hostname-only key is NOT valid for nonstandard ports.
export SERVER_SSH_KNOWN_HOSTS="$SERVER_HOST ssh-ed25519 $key"
if bash "$root/.github/scripts/prepare-pinned-ssh.sh" >/dev/null 2>&1; then
  echo "Accepted hostname-only key for nonstandard port" >&2; exit 1
fi
export SERVER_SSH_KNOWN_HOSTS="[$SERVER_HOST]:2222 ssh-ed25519 $key"
export SERVER_PORT="2200"
if bash "$root/.github/scripts/prepare-pinned-ssh.sh" >/dev/null 2>&1; then
  echo "Accepted wrong SSH port" >&2; exit 1
fi
export SERVER_PORT="2222"
export SERVER_SSH_HOST_KEY_SHA256="SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
if bash "$root/.github/scripts/prepare-pinned-ssh.sh" >/dev/null 2>&1; then
  echo "Accepted wrong SHA256 fingerprint" >&2; exit 1
fi
export SERVER_SSH_HOST_KEY_SHA256="$fingerprint"
export SERVER_SSH_KNOWN_HOSTS="[$SERVER_HOST]:2222 ssh-ed25519 $key
[$SERVER_HOST]:2222 ssh-ed25519 $key"
if bash "$root/.github/scripts/prepare-pinned-ssh.sh" >/dev/null 2>&1; then
  echo "Accepted ambiguous multiple host keys" >&2; exit 1
fi

# Default port correctly matches a plain host key.
export SERVER_PORT="22"
export SERVER_SSH_KNOWN_HOSTS="$SERVER_HOST ssh-ed25519 $key"
bash "$root/.github/scripts/prepare-pinned-ssh.sh" >/dev/null
echo "PINNED_SSH_TEST_OK negative_cases_default_port"
