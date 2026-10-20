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

# Valid out-of-band pin: no network operation is performed.
bash "$root/.github/scripts/prepare-pinned-ssh.sh" >/dev/null
ssh -G -p "$SERVER_PORT" "$SERVER_HOST" |
  grep -Eqi '^stricthostkeychecking yes$'
ssh -G -p "$SERVER_PORT" "$SERVER_HOST" |
  grep -Eqi '^updatehostkeys no$'
ssh -G -p "$SERVER_PORT" "$SERVER_HOST" |
  grep -Eqi '^batchmode yes$'
echo "PINNED_SSH_TEST_OK positive_host_port_fingerprint"

# Hostname-only entry must not authenticate nondefault SSH port.
export SERVER_SSH_KNOWN_HOSTS="$SERVER_HOST ssh-ed25519 $key"
if bash "$root/.github/scripts/prepare-pinned-ssh.sh" >/dev/null 2>&1; then
  echo "Accepted host-only pin for nonstandard port" >&2
  exit 1
fi
# Different configured port must not reuse previously known [host]:2222.
export SERVER_SSH_KNOWN_HOSTS="[$SERVER_HOST]:2222 ssh-ed25519 $key"
export SERVER_PORT="2200"
if bash "$root/.github/scripts/prepare-pinned-ssh.sh" >/dev/null 2>&1; then
  echo "Accepted key for wrong SSH port" >&2
  exit 1
fi
export SERVER_PORT="2222"
# Valid host key + wrong out-of-band fingerprint must fail closed.
export SERVER_SSH_HOST_KEY_SHA256="SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
if bash "$root/.github/scripts/prepare-pinned-ssh.sh" >/dev/null 2>&1; then
  echo "Accepted mismatched host fingerprint" >&2
  exit 1
fi
export SERVER_SSH_HOST_KEY_SHA256="$fingerprint"
# Ambiguous multiple host keys are not accepted; force deliberate rotation.
export SERVER_SSH_KNOWN_HOSTS="[$SERVER_HOST]:2222 ssh-ed25519 $key
[$SERVER_HOST]:2222 ssh-ed25519 $key"
if bash "$root/.github/scripts/prepare-pinned-ssh.sh" >/dev/null 2>&1; then
  echo "Accepted ambiguous multiple keys" >&2
  exit 1
fi
# Default port uses the unbracketed hostname.
export SERVER_PORT="22"
export SERVER_SSH_KNOWN_HOSTS="$SERVER_HOST ssh-ed25519 $key"
bash "$root/.github/scripts/prepare-pinned-ssh.sh" >/dev/null
echo "PINNED_SSH_TEST_OK negative_cases_default_port"
