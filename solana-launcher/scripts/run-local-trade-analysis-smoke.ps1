param(
  [string]$Mint = "DksAcB4w38E7bfzQ2KbjwG3sf95vUPWX9x7rhniwpump"
)

$ErrorActionPreference = "Stop"

$Launcher = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $Launcher "..")).Path
$Memecoin = Join-Path $RepoRoot "memecoin-intelligence"

# Next.js rewrites next-env.d.ts during local builds and memecoin-intelligence
# intentionally may generate a local package-lock during smoke preparation.
# Refuse every other dirty path. These two files are never deleted or reverted.
$allowedGenerated = @(
  "solana-launcher/next-env.d.ts",
  "memecoin-intelligence/package-lock.json"
)
$statusLines = @(git -C $RepoRoot status --porcelain)
if ($LASTEXITCODE -ne 0) { throw "Not a git worktree: $RepoRoot" }
$unexpected = @()
foreach ($line in $statusLines) {
  if (-not $line -or $line.Length -lt 4) { continue }
  $path = $line.Substring(3).Trim()
  if ($allowedGenerated -notcontains $path) { $unexpected += $line }
}
if ($unexpected.Count -gt 0) {
  throw "Smoke worktree has unexpected changes. Nothing was reset or deleted.`n$($unexpected -join "`n")"
}

# npm ci requires a lockfile. Generate it locally if this package does not track
# one; it stays untracked and is ignored only inside this child smoke process.
$memecoinLock = Join-Path $Memecoin "package-lock.json"
if (-not (Test-Path -LiteralPath $memecoinLock)) {
  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  Push-Location $Memecoin
  try {
    & $npm install --package-lock-only --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "Unable to generate memecoin smoke package-lock" }
  } finally { Pop-Location }
}

# The main smoke runner deliberately requires a clean worktree. Temporarily hide
# only the known generated tracked file and all untracked files after the strict
# check above. This does not alter file contents and the index flag is restored.
git -C $RepoRoot update-index --assume-unchanged -- "solana-launcher/next-env.d.ts"
if ($LASTEXITCODE -ne 0) { throw "Unable to mark next-env.d.ts as generated for smoke" }
$env:GIT_CONFIG_COUNT = "1"
$env:GIT_CONFIG_KEY_0 = "status.showUntrackedFiles"
$env:GIT_CONFIG_VALUE_0 = "no"

# The main smoke runner builds a dedicated ignored .env.smoke file and uses it
# for the actual admin process. These process-only values exist solely so the
# earlier static `import app.main_admin` syntax/dependency check has a valid
# development configuration before that child process is started.
$bootstrapDir = Join-Path ([System.IO.Path]::GetTempPath()) "potapoff-admin-smoke-bootstrap"
New-Item -ItemType Directory -Path $bootstrapDir -Force | Out-Null

$env:ADMIN_ENVIRONMENT = "development"
$env:ADMIN_USERNAME = "admin"
$env:ADMIN_PASSWORD = "local-smoke-only"
$env:ADMIN_PASSWORD_HASH = ""
$env:ADMIN_SESSION_SECRET = "local-smoke-session-secret-0123456789abcdef0123456789abcdef"
$env:ADMIN_SECURE_COOKIE = "false"
$env:ADMIN_REQUIRE_MFA = "false"
$env:ADMIN_REQUIRE_REAUTH = "false"
$env:ADMIN_SESSION_BIND_IP = "false"
$env:ADMIN_SESSION_BIND_USER_AGENT = "false"
$env:ADMIN_REQUIRE_NETWORK_ALLOWLIST = "false"
$env:ADMIN_ALLOWED_NETWORKS = ""
$env:ADMIN_ALLOWED_ORIGINS = "http://localhost:18080"
$env:ADMIN_TRUST_PROXY = "false"
$env:ADMIN_STATE_POSTGRES_DSN = ""
$env:ADMIN_WEB_WORKERS = "1"
$env:ADMIN_AUDIT_DB = Join-Path $bootstrapDir "audit.db"
$env:ADMIN_SECRETS_DB = Join-Path $bootstrapDir "integrations.db"
$env:ADMIN_INTELLIGENCE_BACKEND = "sqlite"
$env:ADMIN_INTELLIGENCE_DB = Join-Path $bootstrapDir "intelligence.sqlite3"
$env:ADMIN_SECRETS_MASTER_KEY = "local-smoke-master-key-0123456789abcdef0123456789abcdef"
$env:ADMIN_HELIUS_SERVICE_TOKEN = "local-smoke-helius-token-0123456789abcdef0123456789abcdef"
$env:ADMIN_TELEGRAM_SERVICE_TOKEN = "local-smoke-telegram-token-0123456789abcdef0123456789abcdef"
$env:SUBSCRIPTION_ADMIN_KEY = "local-smoke-subscription-key-0123456789abcdef0123456789abcdef"

$exitCode = 1
try {
  & (Join-Path $PSScriptRoot "local-trade-analysis-smoke.ps1") -Mint $Mint
  $exitCode = $LASTEXITCODE
} finally {
  git -C $RepoRoot update-index --no-assume-unchanged -- "solana-launcher/next-env.d.ts" 2>$null
}
exit $exitCode
