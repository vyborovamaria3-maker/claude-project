#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$ROOT" ]]; then
  echo "[strix] ERROR: run this command inside the claude-project git repository." >&2
  exit 1
fi

ENV_FILE="${STRIX_ENV_FILE:-$ROOT/security/strix/.env}"

# Optional local/VPS configuration. The real file is ignored by git.
# Load it before CLI parsing so explicit command-line flags always win.
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

COMPONENT="${STRIX_COMPONENT:-repo}"
PROFILE="${STRIX_PROFILE:-baseline}"
MODE="${STRIX_SCAN_MODE:-standard}"
BUDGET="${STRIX_MAX_BUDGET:-10}"
SCOPE_MODE="${STRIX_SCOPE_MODE:-full}"
DIFF_BASE="${STRIX_DIFF_BASE:-main}"
REPORT_ROOT="${STRIX_REPORT_DIR:-$ROOT/security/strix/reports}"
STRIX_LLM="${STRIX_LLM:-openai/gpt-5.4}"

usage() {
  cat <<'EOF'
Usage: bash scripts/strix-scan.sh [options]

Options:
  --component NAME   repo | solana-launcher | backend | admin-site | memecoin-intelligence
  --profile NAME     baseline | authz-business | external-llm-infra
  --mode MODE        quick | standard | deep
  --budget USD       positive LLM budget cap (default: 10)
  --scope MODE       full | diff (default: full)
  --diff-base REF    git ref used with --scope diff (default: main)
  --report-dir PATH  local report directory (default: security/strix/reports)
  -h, --help         show this help

Environment:
  LLM_API_KEY        required provider API key
  STRIX_LLM          LiteLLM model id (default: openai/gpt-5.4)
  STRIX_ENV_FILE     optional env file; defaults to security/strix/.env

The scanner always runs against an isolated temporary clone of the committed HEAD.
Uncommitted working-tree changes are intentionally not scanned.
EOF
}

while (($#)); do
  case "$1" in
    --component) COMPONENT="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --budget) BUDGET="${2:-}"; shift 2 ;;
    --scope) SCOPE_MODE="${2:-}"; shift 2 ;;
    --diff-base) DIFF_BASE="${2:-}"; shift 2 ;;
    --report-dir) REPORT_ROOT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[strix] ERROR: unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

case "$COMPONENT" in
  repo) TARGET_REL="." ;;
  solana-launcher) TARGET_REL="solana-launcher" ;;
  backend) TARGET_REL="solana-launcher/backend" ;;
  admin-site) TARGET_REL="admin-site" ;;
  memecoin-intelligence) TARGET_REL="memecoin-intelligence" ;;
  *) echo "[strix] ERROR: unsupported component: $COMPONENT" >&2; exit 1 ;;
esac

case "$PROFILE" in
  baseline) PROFILE_REL="security/strix/instructions/01-baseline-source.md" ;;
  authz-business) PROFILE_REL="security/strix/instructions/02-authz-business.md" ;;
  external-llm-infra) PROFILE_REL="security/strix/instructions/03-external-llm-infra.md" ;;
  *) echo "[strix] ERROR: unsupported profile: $PROFILE" >&2; exit 1 ;;
esac

case "$MODE" in
  quick|standard|deep) ;;
  *) echo "[strix] ERROR: unsupported scan mode: $MODE" >&2; exit 1 ;;
esac

case "$SCOPE_MODE" in
  full|diff) ;;
  *) echo "[strix] ERROR: unsupported scope mode: $SCOPE_MODE" >&2; exit 1 ;;
esac

if ! [[ "$BUDGET" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "[strix] ERROR: --budget must be a positive number." >&2
  exit 1
fi

for command_name in git node docker strix; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "[strix] ERROR: required command not found: $command_name" >&2
    if [[ "$command_name" == "strix" ]]; then
      echo "[strix] Install Strix with: curl -sSL https://strix.ai/install | bash" >&2
    fi
    exit 1
  fi
done

if ! node -e 'const n=Number(process.argv[1]); process.exit(Number.isFinite(n) && n > 0 ? 0 : 1)' "$BUDGET"; then
  echo "[strix] ERROR: --budget must be greater than zero." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[strix] ERROR: Docker is installed but the daemon is not available." >&2
  exit 1
fi

if [[ -z "${LLM_API_KEY:-}" ]]; then
  echo "[strix] ERROR: LLM_API_KEY is not set." >&2
  echo "[strix] Put it in security/strix/.env (ignored by git) or export it in the shell." >&2
  exit 1
fi

for required_file in \
  "$ROOT/security/strix/ROE_SOURCE_ONLY.md" \
  "$ROOT/$PROFILE_REL" \
  "$ROOT/scripts/strix-check-result.mjs"; do
  if [[ ! -f "$required_file" ]]; then
    echo "[strix] ERROR: required file missing: $required_file" >&2
    exit 1
  fi
done

if [[ "$REPORT_ROOT" != /* ]]; then
  REPORT_ROOT="$ROOT/$REPORT_ROOT"
fi
mkdir -p "$REPORT_ROOT"
REPORT_ROOT="$(cd "$REPORT_ROOT" && pwd -P)"

HEAD_SHA="$(git -C "$ROOT" rev-parse HEAD)"
SHORT_SHA="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
BRANCH="$(git -C "$ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || echo detached)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$REPORT_ROOT/${STAMP}-${COMPONENT}-${PROFILE}-${MODE}-${SHORT_SHA}"
RUNTIME_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/claude-strix.XXXXXX")"
SCAN_REPO="$RUNTIME_ROOT/repo"
RUN_HOME="$RUNTIME_ROOT/run"
INSTRUCTION_FILE="$RUNTIME_ROOT/instructions.md"
CONSOLE_LOG="$RUN_HOME/strix-console.log"

cleanup() {
  rm -rf "$RUNTIME_ROOT"
}
trap cleanup EXIT

mkdir -p "$RUN_HOME" "$DEST"

# A full temporary clone keeps .git metadata self-contained for diff scans while
# protecting the developer's working tree from Strix's writable target mount.
echo "[strix] Preparing isolated scan clone for $SHORT_SHA..."
git clone --no-hardlinks --quiet "$ROOT" "$SCAN_REPO"
git -C "$SCAN_REPO" checkout --quiet --detach "$HEAD_SHA"

TARGET="$SCAN_REPO/$TARGET_REL"
if [[ ! -e "$TARGET" ]]; then
  echo "[strix] ERROR: selected component does not exist: $TARGET_REL" >&2
  exit 1
fi

cat \
  "$SCAN_REPO/security/strix/ROE_SOURCE_ONLY.md" \
  "$SCAN_REPO/$PROFILE_REL" \
  > "$INSTRUCTION_FILE"

ARGS=(
  strix
  -n
  --target "$TARGET"
  --scan-mode "$MODE"
  --scope-mode "$SCOPE_MODE"
  --instruction-file "$INSTRUCTION_FILE"
  --max-budget "$BUDGET"
)

if [[ "$SCOPE_MODE" == "diff" ]]; then
  if ! git -C "$SCAN_REPO" rev-parse --verify --quiet "$DIFF_BASE^{commit}" >/dev/null; then
    REMOTE_DIFF_BASE="origin/$DIFF_BASE"
    if git -C "$SCAN_REPO" rev-parse --verify --quiet "$REMOTE_DIFF_BASE^{commit}" >/dev/null; then
      DIFF_BASE="$REMOTE_DIFF_BASE"
    else
      echo "[strix] ERROR: diff base cannot be resolved in isolated clone: $DIFF_BASE" >&2
      exit 1
    fi
  fi
  ARGS+=(--diff-base "$DIFF_BASE")
fi

echo "[strix] Model: $STRIX_LLM"
echo "[strix] Commit: $HEAD_SHA ($BRANCH)"
echo "[strix] Component: $COMPONENT"
echo "[strix] Profile: $PROFILE"
echo "[strix] Mode/scope: $MODE / $SCOPE_MODE"
echo "[strix] Budget cap: $BUDGET USD"
echo "[strix] Reports: $DEST"

export STRIX_LLM
cd "$RUN_HOME"

set +e
"${ARGS[@]}" 2>&1 | tee "$CONSOLE_LOG"
STRIX_RC=${PIPESTATUS[0]}
set -e

cp "$CONSOLE_LOG" "$DEST/strix-console.log"

LATEST_RUN=""
if compgen -G "$RUN_HOME/strix_runs/*/run.json" >/dev/null; then
  LATEST_JSON="$(ls -t "$RUN_HOME"/strix_runs/*/run.json | head -n 1)"
  LATEST_RUN="$(dirname "$LATEST_JSON")"
  cp -a "$LATEST_RUN"/. "$DEST"/
fi

cat > "$DEST/local-run.txt" <<EOF
commit=$HEAD_SHA
branch=$BRANCH
component=$COMPONENT
profile=$PROFILE
scan_mode=$MODE
scope_mode=$SCOPE_MODE
diff_base=$DIFF_BASE
max_budget_usd=$BUDGET
strix_llm=$STRIX_LLM
strix_exit_code=$STRIX_RC
started_from=$ROOT
EOF

if [[ -z "$LATEST_RUN" || ! -f "$DEST/run.json" ]]; then
  echo "[strix] ERROR: Strix did not produce run.json; evidence preserved in $DEST" >&2
  exit 1
fi

set +e
node "$ROOT/scripts/strix-check-result.mjs" "$DEST/run.json" "$BUDGET"
VERIFY_RC=$?
set -e

if [[ "$VERIFY_RC" -ne 0 ]]; then
  echo "[strix] ERROR: incomplete/invalid Strix run; evidence preserved in $DEST" >&2
  exit 1
fi

case "$STRIX_RC" in
  0)
    echo "[strix] PASS: completed scan with no validated vulnerabilities reported."
    echo "[strix] Report: $DEST/penetration_test_report.md"
    exit 0
    ;;
  2)
    echo "[strix] FAIL: Strix reported validated vulnerabilities." >&2
    echo "[strix] Report: $DEST/penetration_test_report.md" >&2
    exit 2
    ;;
  *)
    echo "[strix] ERROR: Strix exited with code $STRIX_RC; evidence preserved in $DEST" >&2
    exit "$STRIX_RC"
    ;;
esac
