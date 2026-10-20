#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Trust-on-first-use and ssh-keyscan are deliberately forbidden.
for required in SERVER_HOST SERVER_PORT SERVER_USER SERVER_SSH_KEY SERVER_SSH_KNOWN_HOSTS SERVER_SSH_HOST_KEY_SHA256 HOME; do
  [[ -n "$(printenv "$required" 2>/dev/null)" ]] || { echo "Missing SSH configuration: $required" >&2; exit 1; }
done
if [[ ! "$SERVER_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$ ||
      ! "$SERVER_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]{0,31}$ ||
      ! "$SERVER_PORT" =~ ^[1-9][0-9]{0,4}$ ]] ||
    (( 10#$SERVER_PORT > 65535 )); then
  echo "Invalid SSH host, port or user syntax" >&2
  exit 1
fi
# The operator obtains this exact fingerprint out of band.
if [[ ! "$SERVER_SSH_HOST_KEY_SHA256" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]]; then
  echo "SERVER_SSH_HOST_KEY_SHA256 must be a verified SHA256:... fingerprint" >&2
  exit 1
fi
if (( $(printf '%s' "$SERVER_SSH_KNOWN_HOSTS" | wc -c) > 16384 )); then
  echo "SSH known_hosts secret is too large" >&2
  exit 1
fi
command -v ssh-keygen >/dev/null
command -v ssh >/dev/null
ssh_dir="$HOME/.ssh"
install -d -m 0700 "$ssh_dir"
printf '%s\n' "$SERVER_SSH_KEY" > "$ssh_dir/deploy_key"
chmod 0600 "$ssh_dir/deploy_key"
printf '%s\n' "$SERVER_SSH_KNOWN_HOSTS" > "$ssh_dir/known_hosts"
chmod 0600 "$ssh_dir/known_hosts"

# OpenSSH uses [hostname]:port for non-default ports. A plain hostname match
# is not enough and was the previous source of host-key validation failures.
host_lookup="$SERVER_HOST"
if [[ "$SERVER_PORT" != "22" ]]; then host_lookup="[$SERVER_HOST]:$SERVER_PORT"; fi
key_lines="$(ssh-keygen -F "$host_lookup" -f "$ssh_dir/known_hosts" 2>/dev/null |
  grep -v '^#' || true)"
key_count="$(printf '%s\n' "$key_lines" | sed '/^$/d' | wc -l | tr -d ' ')"
if [[ "$key_count" != "1" ]]; then
  echo "Expected exactly one pinned host key for the configured host and port" >&2
  exit 1
fi
keyfile="$(mktemp "$ssh_dir/.hostkey.XXXXXX")"
trap 'rm -f "$keyfile"' EXIT
printf '%s\n' "$key_lines" > "$keyfile"
actual="$(ssh-keygen -lf "$keyfile" -E sha256 2>/dev/null | awk 'NR==1 {print $2}')"
if [[ "$actual" != "$SERVER_SSH_HOST_KEY_SHA256" ]]; then
  echo "Pinned SSH host fingerprint mismatch; refusing connection" >&2
  exit 1
fi

cat > "$ssh_dir/config" <<EOF
Host $SERVER_HOST
    HostName $SERVER_HOST
    Port $SERVER_PORT
    User $SERVER_USER
    IdentityFile $ssh_dir/deploy_key
    UserKnownHostsFile $ssh_dir/known_hosts
    GlobalKnownHostsFile /dev/null
    StrictHostKeyChecking yes
    UpdateHostKeys no
    VerifyHostKeyDNS no
    CheckHostIP no
    BatchMode yes
    IdentitiesOnly yes
    ForwardAgent no
    ConnectTimeout 10
    LogLevel ERROR
EOF
chmod 0600 "$ssh_dir/config"
rm -f "$keyfile"
trap - EXIT
echo "PINNED_SSH_CONFIG_OK host_key_sha256_verified=true"
