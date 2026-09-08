param(
  [string]$Mint = "DksAcB4w38E7bfzQ2KbjwG3sf95vUPWX9x7rhniwpump"
)

$ErrorActionPreference = "Stop"

# The main smoke runner builds a dedicated ignored .env.smoke file and uses it
# for the actual admin process. These process-only values exist solely so the
# earlier static `import app.main_admin` syntax/dependency check has a valid
# development configuration before that child process is started.
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
$env:ADMIN_SECRETS_MASTER_KEY = "local-smoke-master-key-0123456789abcdef0123456789abcdef"
$env:ADMIN_HELIUS_SERVICE_TOKEN = "local-smoke-helius-token-0123456789abcdef0123456789abcdef"
$env:ADMIN_TELEGRAM_SERVICE_TOKEN = "local-smoke-telegram-token-0123456789abcdef0123456789abcdef"
$env:SUBSCRIPTION_ADMIN_KEY = "local-smoke-subscription-key-0123456789abcdef0123456789abcdef"

& (Join-Path $PSScriptRoot "local-trade-analysis-smoke.ps1") -Mint $Mint
exit $LASTEXITCODE
