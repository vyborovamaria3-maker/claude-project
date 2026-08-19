#!/usr/bin/env bash
set -euo pipefail

WEBSCAN_REPOSITORY="https://github.com/feadal/Web-vuln-scanner.git"
WEBSCAN_REF="9241341a066ac72f6fbf1b4c87b753915195a736"
TOOLS_ROOT="${SECURITY_TOOLS_ROOT:-$HOME/.local/share/potapoff-security-tools}"
SOURCE_DIR="$TOOLS_ROOT/Web-vuln-scanner"
VENV_DIR="$TOOLS_ROOT/webscan-venv"
BIN_DIR="${SECURITY_TOOLS_BIN:-$HOME/.local/bin}"

command -v git >/dev/null || { echo 'git is required' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'python3 is required' >&2; exit 1; }

mkdir -p "$TOOLS_ROOT" "$BIN_DIR"
chmod 700 "$TOOLS_ROOT"

if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  rm -rf "$SOURCE_DIR"
  git clone --filter=blob:none "$WEBSCAN_REPOSITORY" "$SOURCE_DIR"
fi

git -C "$SOURCE_DIR" fetch --force origin "$WEBSCAN_REF"
git -C "$SOURCE_DIR" checkout --detach "$WEBSCAN_REF"
actual_ref="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
[[ "$actual_ref" == "$WEBSCAN_REF" ]] || { echo 'webscan source SHA mismatch' >&2; exit 1; }

rm -rf "$VENV_DIR"
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --disable-pip-version-check --upgrade pip setuptools wheel
"$VENV_DIR/bin/python" -m pip install --disable-pip-version-check "$SOURCE_DIR"

ln -sfn "$VENV_DIR/bin/webscan" "$BIN_DIR/webscan"
"$BIN_DIR/webscan" --version
"$BIN_DIR/webscan" --list-checks >/dev/null

echo "WEBSCAN_INSTALL_OK ref=$WEBSCAN_REF bin=$BIN_DIR/webscan"
