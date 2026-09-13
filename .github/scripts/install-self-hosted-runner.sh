#!/usr/bin/env bash
set -Eeuo pipefail

repo_url="${GITHUB_REPOSITORY_URL:-https://github.com/vyborovamaria3-maker/claude-project}"
runner_version="${ACTIONS_RUNNER_VERSION:-2.337.0}"
runner_user="${RUNNER_USER:-github-runner}"
runner_dir="${RUNNER_DIR:-/opt/actions-runner/claude-project}"
runner_name="${RUNNER_NAME:-potapoff-$(hostname -s)}"
runner_labels="${RUNNER_LABELS:-self-hosted,Linux,X64,potapoff-linux}"

if [[ $EUID -ne 0 ]]; then
  echo "Run this script as root or with sudo." >&2
  exit 1
fi

if [[ -z "${RUNNER_TOKEN:-}" ]]; then
  echo "Set RUNNER_TOKEN to a fresh repository self-hosted runner registration token." >&2
  exit 1
fi

apt-get update
apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  curl \
  git \
  jq \
  tar

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

if ! getent group docker >/dev/null; then
  groupadd docker
fi

if ! id "$runner_user" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$runner_user"
fi

usermod -aG docker "$runner_user"
mkdir -p "$runner_dir"
chown -R "$runner_user:$runner_user" "$runner_dir"

archive="actions-runner-linux-x64-${runner_version}.tar.gz"
download_url="https://github.com/actions/runner/releases/download/v${runner_version}/${archive}"

sudo -u "$runner_user" bash -lc "
  set -Eeuo pipefail
  cd '$runner_dir'
  if [[ ! -x ./config.sh ]]; then
    curl -fsSLo '$archive' '$download_url'
    tar xzf '$archive'
    rm -f '$archive'
  fi

  if [[ ! -f .runner ]]; then
    ./config.sh \
      --url '$repo_url' \
      --token '$RUNNER_TOKEN' \
      --name '$runner_name' \
      --labels '$runner_labels' \
      --unattended \
      --replace
  fi
"

"$runner_dir/svc.sh" install "$runner_user"
"$runner_dir/svc.sh" start
"$runner_dir/svc.sh" status

echo "SELF_HOSTED_RUNNER_READY name=$runner_name labels=$runner_labels"
