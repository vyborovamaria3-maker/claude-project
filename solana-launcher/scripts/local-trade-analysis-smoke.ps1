param(
  [string]$Mint = "DksAcB4w38E7bfzQ2KbjwG3sf95vUPWX9x7rhniwpump"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Step([string]$Message) {
  Write-Host "`n=== $Message ===" -ForegroundColor Cyan
}

function New-HexSecret([int]$Bytes = 32) {
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return ([System.BitConverter]::ToString($buffer)).Replace("-", "").ToLowerInvariant()
}

function Get-EnvValue([string]$File, [string]$Key) {
  if (-not (Test-Path -LiteralPath $File)) { return "" }
  $pattern = "^\s*" + [regex]::Escape($Key) + "=(.*)$"
  $value = ""
  foreach ($line in Get-Content -LiteralPath $File) {
    if ($line -match $pattern) { $value = $matches[1].Trim() }
  }
  return $value
}

function Set-EnvValue([string]$File, [string]$Key, [string]$Value) {
  $lines = @()
  if (Test-Path -LiteralPath $File) { $lines = @(Get-Content -LiteralPath $File) }
  $pattern = "^\s*" + [regex]::Escape($Key) + "="
  $output = New-Object System.Collections.Generic.List[string]
  $written = $false
  foreach ($line in $lines) {
    if ($line -match $pattern) {
      if (-not $written) {
        $output.Add("$Key=$Value")
        $written = $true
      }
      continue
    }
    $output.Add($line)
  }
  if (-not $written) { $output.Add("$Key=$Value") }
  Set-Content -LiteralPath $File -Value $output -Encoding UTF8
}

function Copy-IfMissing([string]$Source, [string]$Destination) {
  if ((Test-Path -LiteralPath $Source) -and -not (Test-Path -LiteralPath $Destination)) {
    Copy-Item -LiteralPath $Source -Destination $Destination
  }
}

function Import-EnvKeys([string[]]$Sources, [string]$Destination, [string[]]$Keys) {
  if (-not (Test-Path -LiteralPath $Destination)) { New-Item -ItemType File -Path $Destination -Force | Out-Null }
  foreach ($key in $Keys) {
    if (Get-EnvValue $Destination $key) { continue }
    foreach ($source in $Sources) {
      $value = Get-EnvValue $source $key
      if ($value) {
        Set-EnvValue $Destination $key $value
        break
      }
    }
  }
}

function Wait-Http([string]$Url, [int]$Attempts = 60) {
  for ($i = 0; $i -lt $Attempts; $i++) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 4
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return $true }
    } catch {}
    Start-Sleep -Seconds 2
  }
  return $false
}

function Find-HeliusKey([string[]]$Files) {
  $singleKeys = @("HELIUS_API_KEY_1", "HELIUS_API_KEY_2", "HELIUS_API_KEY_3", "HELIUS_API_KEY_4", "HELIUS_API_KEY_5", "HELIUS_API_KEY", "NEXT_PUBLIC_HELIUS_API_KEY")
  foreach ($file in $Files) {
    $many = Get-EnvValue $file "HELIUS_API_KEYS"
    if ($many) {
      $first = ($many -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -First 1)
      if ($first) { return $first }
    }
    foreach ($keyName in $singleKeys) {
      $value = Get-EnvValue $file $keyName
      if ($value) { return $value }
    }
    foreach ($urlName in @("HELIUS_RPC_URL", "NEXT_PUBLIC_HELIUS_RPC_URL", "NEXT_PUBLIC_RPC_URL")) {
      $value = Get-EnvValue $file $urlName
      if ($value -match "[?&]api-key=([^&]+)") { return [uri]::UnescapeDataString($matches[1]) }
    }
  }
  return ""
}

function Write-EnvRunner([string]$Path, [string]$EnvFile, [string]$WorkingDir, [string]$Executable, [string[]]$Arguments) {
  $quotedArgs = ($Arguments | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ","
  $content = @"
`$ErrorActionPreference = 'Stop'
Get-Content -LiteralPath '$($EnvFile -replace "'", "''")' | ForEach-Object {
  if (`$_ -match '^\s*#' -or `$_ -notmatch '=') { return }
  `$pair = `$_ -split '=', 2
  [Environment]::SetEnvironmentVariable(`$pair[0].Trim(), `$pair[1], 'Process')
}
Set-Location -LiteralPath '$($WorkingDir -replace "'", "''")'
& '$($Executable -replace "'", "''")' @($quotedArgs)
"@
  Set-Content -LiteralPath $Path -Value $content -Encoding UTF8
}

$Launcher = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $Launcher "..")).Path
$Backend = Join-Path $Launcher "backend"
$Memecoin = Join-Path $RepoRoot "memecoin-intelligence"
$Admin = Join-Path $RepoRoot "admin-site"
$SmokeDir = Join-Path $RepoRoot ".smoke-trade-analysis"
$LogsDir = Join-Path $SmokeDir "logs"
$OriginalRepo = Join-Path (Split-Path $RepoRoot -Parent) "claude-project"

New-Item -ItemType Directory -Path $SmokeDir -Force | Out-Null
New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null

Step "Safety check"
$dirty = git -C $RepoRoot status --porcelain
if ($LASTEXITCODE -ne 0) { throw "Not a git worktree: $RepoRoot" }
if ($dirty) { throw "Smoke worktree is not clean. Refusing to overwrite tracked work.`n$dirty" }
Write-Host "Worktree: $RepoRoot"
Write-Host "Commit: $(git -C $RepoRoot rev-parse --short HEAD)"

Step "Prepare ignored local configuration"
$FrontendEnv = Join-Path $Launcher ".env.development.local"
$BackendEnv = Join-Path $Backend ".env"
$MemecoinEnv = Join-Path $Memecoin ".env"
$AdminEnv = Join-Path $Admin ".env.smoke"

if (Test-Path -LiteralPath $OriginalRepo) {
  Copy-IfMissing (Join-Path $OriginalRepo "solana-launcher\.env.development.local") $FrontendEnv
  Copy-IfMissing (Join-Path $OriginalRepo "solana-launcher\backend\.env") $BackendEnv
  Copy-IfMissing (Join-Path $OriginalRepo "memecoin-intelligence\.env") $MemecoinEnv
}
if (-not (Test-Path -LiteralPath $FrontendEnv)) { New-Item -ItemType File -Path $FrontendEnv -Force | Out-Null }
if (-not (Test-Path -LiteralPath $BackendEnv)) { New-Item -ItemType File -Path $BackendEnv -Force | Out-Null }
if (-not (Test-Path -LiteralPath $MemecoinEnv)) { Copy-Item (Join-Path $Memecoin ".env.example") $MemecoinEnv }
if (-not (Test-Path -LiteralPath $AdminEnv)) { Copy-Item (Join-Path $Admin ".env.example") $AdminEnv }

$frontendSources = @(
  (Join-Path $OriginalRepo "solana-launcher\.env.development.local"),
  (Join-Path $OriginalRepo "solana-launcher\.env.local"),
  (Join-Path $OriginalRepo "solana-launcher\.env")
)
Import-EnvKeys $frontendSources $FrontendEnv @(
  "HELIUS_API_KEYS", "HELIUS_API_KEY_1", "HELIUS_API_KEY_2", "HELIUS_API_KEY_3", "HELIUS_API_KEY_4", "HELIUS_API_KEY_5", "HELIUS_API_KEY",
  "NEXT_PUBLIC_HELIUS_API_KEY", "HELIUS_RPC_URL", "NEXT_PUBLIC_HELIUS_RPC_URL", "NEXT_PUBLIC_RPC_URL", "BITQUERY_API_KEY",
  "BACKEND_API_KEY", "INTERNAL_API_KEY", "SOLSCAN_API_TOKEN", "PUMPFUN_JWT", "TWITTERAPI_IO_KEY", "X_BEARER_TOKEN"
)

if (Test-Path -LiteralPath (Join-Path $OriginalRepo "solana-launcher\backend\.env")) {
  Import-EnvKeys @((Join-Path $OriginalRepo "solana-launcher\backend\.env")) $BackendEnv @(
    "TG_API_ID", "TG_API_HASH", "TG_SESSION_STRING", "TG_MONITOR_CHANNELS", "TG_AUTOSTART", "TG_PUBLIC_WEB_ENABLED", "TG_PUBLIC_WEB_CHANNELS",
    "BACKEND_API_KEY", "INTERNAL_API_KEY", "DATABASE_URL", "REDIS_URL"
  )
}

Set-EnvValue $AdminEnv "ADMIN_ENVIRONMENT" "development"
Set-EnvValue $AdminEnv "ADMIN_USERNAME" "admin"
Set-EnvValue $AdminEnv "ADMIN_PASSWORD_HASH" ""
Set-EnvValue $AdminEnv "ADMIN_PASSWORD" "local-smoke-only"
Set-EnvValue $AdminEnv "ADMIN_SECURE_COOKIE" "false"
Set-EnvValue $AdminEnv "ADMIN_REQUIRE_MFA" "false"
Set-EnvValue $AdminEnv "ADMIN_REQUIRE_REAUTH" "false"
Set-EnvValue $AdminEnv "ADMIN_SESSION_BIND_IP" "false"
Set-EnvValue $AdminEnv "ADMIN_SESSION_BIND_USER_AGENT" "false"
Set-EnvValue $AdminEnv "ADMIN_REQUIRE_NETWORK_ALLOWLIST" "false"
Set-EnvValue $AdminEnv "ADMIN_ALLOWED_NETWORKS" ""
Set-EnvValue $AdminEnv "ADMIN_ALLOWED_ORIGINS" "http://localhost:18080"
Set-EnvValue $AdminEnv "ADMIN_TRUST_PROXY" "false"
Set-EnvValue $AdminEnv "ADMIN_STATE_POSTGRES_DSN" ""
Set-EnvValue $AdminEnv "ADMIN_WEB_WORKERS" "1"
Set-EnvValue $AdminEnv "ADMIN_AUDIT_DB" (Join-Path $SmokeDir "admin-audit.db")
Set-EnvValue $AdminEnv "ADMIN_SECRETS_DB" (Join-Path $SmokeDir "integrations.db")
Set-EnvValue $AdminEnv "ADMIN_SOURCES_FILE" (Join-Path $Admin "sources.json")
Set-EnvValue $AdminEnv "ADMIN_LOGS_FILE" (Join-Path $Admin "logs.json")
if (-not (Get-EnvValue $AdminEnv "ADMIN_SESSION_SECRET")) { Set-EnvValue $AdminEnv "ADMIN_SESSION_SECRET" (New-HexSecret 48) }
if (-not (Get-EnvValue $AdminEnv "ADMIN_SECRETS_MASTER_KEY")) { Set-EnvValue $AdminEnv "ADMIN_SECRETS_MASTER_KEY" (New-HexSecret 32) }
if (-not (Get-EnvValue $AdminEnv "ADMIN_HELIUS_SERVICE_TOKEN")) { Set-EnvValue $AdminEnv "ADMIN_HELIUS_SERVICE_TOKEN" (New-HexSecret 32) }
if (-not (Get-EnvValue $AdminEnv "ADMIN_TELEGRAM_SERVICE_TOKEN")) { Set-EnvValue $AdminEnv "ADMIN_TELEGRAM_SERVICE_TOKEN" (New-HexSecret 32) }
if (-not (Get-EnvValue $AdminEnv "SUBSCRIPTION_ADMIN_KEY")) { Set-EnvValue $AdminEnv "SUBSCRIPTION_ADMIN_KEY" (New-HexSecret 32) }

$AdminHeliusToken = Get-EnvValue $AdminEnv "ADMIN_HELIUS_SERVICE_TOKEN"
$AdminTelegramToken = Get-EnvValue $AdminEnv "ADMIN_TELEGRAM_SERVICE_TOKEN"
Set-EnvValue $FrontendEnv "NEXT_PUBLIC_BACKEND_URL" "http://localhost:18000"
Set-EnvValue $FrontendEnv "BACKEND_URL" "http://localhost:18000"
Set-EnvValue $FrontendEnv "MEMECOIN_INTELLIGENCE_URL" "http://localhost:3101"
Set-EnvValue $FrontendEnv "NEXT_PUBLIC_MEMECOIN_INTELLIGENCE_URL" "http://localhost:3101"
Set-EnvValue $FrontendEnv "ADMIN_INTEGRATIONS_BASE_URL" "http://localhost:18080"
Set-EnvValue $FrontendEnv "ADMIN_HELIUS_SERVICE_TOKEN" $AdminHeliusToken
Set-EnvValue $BackendEnv "ADMIN_INTEGRATIONS_BASE_URL" "http://localhost:18080"
Set-EnvValue $BackendEnv "ADMIN_TELEGRAM_SERVICE_TOKEN" $AdminTelegramToken

if (-not (Get-EnvValue $MemecoinEnv "POSTGRES_PASSWORD")) { Set-EnvValue $MemecoinEnv "POSTGRES_PASSWORD" (New-HexSecret 16) }
if (-not (Get-EnvValue $MemecoinEnv "REDIS_PASSWORD")) { Set-EnvValue $MemecoinEnv "REDIS_PASSWORD" (New-HexSecret 16) }
$pgUser = Get-EnvValue $MemecoinEnv "POSTGRES_USER"; if (-not $pgUser) { $pgUser = "memecoin"; Set-EnvValue $MemecoinEnv "POSTGRES_USER" $pgUser }
$pgDb = Get-EnvValue $MemecoinEnv "POSTGRES_DB"; if (-not $pgDb) { $pgDb = "memecoin"; Set-EnvValue $MemecoinEnv "POSTGRES_DB" $pgDb }
$pgPass = Get-EnvValue $MemecoinEnv "POSTGRES_PASSWORD"
$redisPass = Get-EnvValue $MemecoinEnv "REDIS_PASSWORD"
Set-EnvValue $MemecoinEnv "DATABASE_URL" "postgresql://${pgUser}:${pgPass}@localhost:5432/${pgDb}"
Set-EnvValue $MemecoinEnv "REDIS_URL" "redis://:${redisPass}@localhost:6379"
Set-EnvValue $MemecoinEnv "PORT" "3101"
Set-EnvValue $MemecoinEnv "TELEGRAM_AI_ENABLED" "true"
Set-EnvValue $MemecoinEnv "TELEGRAM_AI_BASE_URL" "http://localhost:8002/v1"
Set-EnvValue $MemecoinEnv "TELEGRAM_AI_MODEL" "Qwen/Qwen2.5-7B-Instruct"
Set-EnvValue $MemecoinEnv "QWEN_HOST_PORT" "8002"

$realQwen = $false
try {
  & nvidia-smi -L *> $null
  if ($LASTEXITCODE -eq 0) { $realQwen = $true }
} catch {}
if (-not $realQwen) {
  try {
    $null = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:8002/health" -TimeoutSec 2
    $realQwen = $true
  } catch {}
}
Set-EnvValue $MemecoinEnv "TELEGRAM_AI_MODE" $(if ($realQwen) { "openai-compatible" } else { "mock" })
Write-Host "Helius config present: $([bool](Find-HeliusKey @($FrontendEnv)))"
Write-Host "Telegram credentials present: $([bool]((Get-EnvValue $BackendEnv 'TG_API_ID') -and (Get-EnvValue $BackendEnv 'TG_API_HASH') -and (Get-EnvValue $BackendEnv 'TG_SESSION_STRING')))"
Write-Host "Qwen mode selected: $(if ($realQwen) { 'REAL openai-compatible' } else { 'MOCK fallback (no local NVIDIA/Qwen health detected)' })"

Step "Install dependencies and compile/build"
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$python = (Get-Command python.exe -ErrorAction Stop).Source

Push-Location $Launcher
try {
  & $npm ci --legacy-peer-deps
  if ($LASTEXITCODE -ne 0) { throw "frontend npm ci failed" }
  & $npm run build
  if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }
} finally { Pop-Location }

Push-Location $Memecoin
try {
  & $npm ci
  if ($LASTEXITCODE -ne 0) { throw "memecoin npm ci failed" }
  & $npm run build
  if ($LASTEXITCODE -ne 0) { throw "memecoin build failed" }
} finally { Pop-Location }

$BackendVenv = Join-Path $SmokeDir "venv-backend"
$AdminVenv = Join-Path $SmokeDir "venv-admin"
if (-not (Test-Path (Join-Path $BackendVenv "Scripts\python.exe"))) { & $python -m venv $BackendVenv }
if (-not (Test-Path (Join-Path $AdminVenv "Scripts\python.exe"))) { & $python -m venv $AdminVenv }
$BackendPython = Join-Path $BackendVenv "Scripts\python.exe"
$AdminPython = Join-Path $AdminVenv "Scripts\python.exe"
& $BackendPython -m pip install -q --disable-pip-version-check -r (Join-Path $Backend "requirements.txt")
& $AdminPython -m pip install -q --disable-pip-version-check -r (Join-Path $Admin "requirements.txt")
& $BackendPython -m compileall -q (Join-Path $Backend "app")
& $AdminPython -m compileall -q (Join-Path $Admin "app")
Push-Location $Admin
try {
  & $AdminPython -c "import cryptography; import app.main_admin; print('ADMIN_IMPORT_OK')"
  if ($LASTEXITCODE -ne 0) { throw "admin import failed" }
} finally { Pop-Location }

if (Get-Command docker.exe -ErrorAction SilentlyContinue) {
  Push-Location $Admin
  try {
    docker build -q -t potapoff-admin-smoke:local . | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "admin docker build failed" }
    docker run --rm --entrypoint python potapoff-admin-smoke:local -c "import cryptography; print('ADMIN_DOCKER_CRYPTO_OK')"
    if ($LASTEXITCODE -ne 0) { throw "admin docker dependency check failed" }
  } finally { Pop-Location }
}
Write-Host "BUILD=OK" -ForegroundColor Green

Step "Stop previous smoke processes"
$PidFile = Join-Path $SmokeDir "pids.json"
if (Test-Path -LiteralPath $PidFile) {
  try {
    $old = Get-Content -Raw -LiteralPath $PidFile | ConvertFrom-Json
    foreach ($property in $old.PSObject.Properties) {
      $pidValue = [int]$property.Value
      if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) { Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue }
    }
  } catch {}
}

Step "Start Memecoin infrastructure"
if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw "Docker is required for PostgreSQL/Redis/Qwen smoke infrastructure" }
Push-Location $Memecoin
try {
  if ($realQwen) {
    docker compose --profile ai up -d postgres redis qwen
  } else {
    docker compose up -d postgres redis
  }
  if ($LASTEXITCODE -ne 0) { throw "memecoin docker compose failed" }
  & $npm run db:migrate
  if ($LASTEXITCODE -ne 0) { throw "memecoin migrations failed" }
} finally { Pop-Location }

Step "Create service runners"
$AdminRunner = Join-Path $SmokeDir "run-admin.ps1"
$BackendRunner = Join-Path $SmokeDir "run-backend.ps1"
$AiRunner = Join-Path $SmokeDir "run-ai.ps1"
$WorkerRunner = Join-Path $SmokeDir "run-worker.ps1"
$FrontendRunner = Join-Path $SmokeDir "run-frontend.ps1"
Write-EnvRunner $AdminRunner $AdminEnv $Admin $AdminPython @("-m", "uvicorn", "app.main_admin:app", "--host", "127.0.0.1", "--port", "18080")
Write-EnvRunner $BackendRunner $BackendEnv $Backend $BackendPython @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "18000")
Write-EnvRunner $AiRunner $MemecoinEnv $Memecoin $npm @("run", "dev:api")
Write-EnvRunner $WorkerRunner $MemecoinEnv $Memecoin $npm @("run", "dev:worker")
Write-EnvRunner $FrontendRunner $FrontendEnv $Launcher $npm @("run", "dev", "--", "-p", "3100")

Step "Start Admin and seed encrypted integration store"
$processes = @{}
$processes.admin = (Start-Process powershell.exe -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", $AdminRunner) -PassThru -WindowStyle Minimized).Id
if (-not (Wait-Http "http://localhost:18080/api/ready" 45)) { throw "Admin did not become ready. Check $LogsDir / admin window." }

$adminSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$adminSession.Headers.Add("Origin", "http://localhost:18080")
$loginBody = @{ username = "admin"; password = "local-smoke-only" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:18080/api/login" -Method Post -ContentType "application/json" -Body $loginBody -WebSession $adminSession | Out-Null
$summary = Invoke-RestMethod -Uri "http://localhost:18080/api/integrations" -WebSession $adminSession

$heliusKey = Find-HeliusKey @($FrontendEnv)
if ($heliusKey -and @($summary.helius.keys).Count -eq 0) {
  $body = @{ name = "Local smoke Helius"; api_key = $heliusKey } | ConvertTo-Json
  Invoke-RestMethod -Uri "http://localhost:18080/api/integrations/helius/keys" -Method Post -ContentType "application/json" -Body $body -WebSession $adminSession | Out-Null
}

$tgId = Get-EnvValue $BackendEnv "TG_API_ID"
$tgHash = Get-EnvValue $BackendEnv "TG_API_HASH"
$tgSession = Get-EnvValue $BackendEnv "TG_SESSION_STRING"
if ($tgId -and $tgHash) {
  $body = @{ api_id = [int]$tgId; api_hash = $tgHash } | ConvertTo-Json
  Invoke-RestMethod -Uri "http://localhost:18080/api/integrations/telegram/credentials" -Method Put -ContentType "application/json" -Body $body -WebSession $adminSession | Out-Null
}
if ($tgSession) {
  $body = @{ session_string = $tgSession } | ConvertTo-Json
  Invoke-RestMethod -Uri "http://localhost:18080/api/integrations/telegram/session" -Method Put -ContentType "application/json" -Body $body -WebSession $adminSession | Out-Null
}

$summary = Invoke-RestMethod -Uri "http://localhost:18080/api/integrations" -WebSession $adminSession
$activeKey = @($summary.helius.keys | Where-Object { $_.enabled } | Select-Object -First 1)
$heliusStatus = "MISSING"
if ($activeKey.Count -gt 0) {
  try {
    $test = Invoke-RestMethod -Uri ("http://localhost:18080/api/integrations/helius/keys/" + $activeKey[0].id + "/test") -Method Post -WebSession $adminSession
    $heliusStatus = if ($test.ok) { "OK" } else { "FAILED" }
  } catch { $heliusStatus = "FAILED" }
}
$internalHelius = Invoke-RestMethod -Uri "http://localhost:18080/internal/integrations/helius" -Headers @{ "X-Integration-Service-Key" = $AdminHeliusToken }
$internalTelegram = Invoke-RestMethod -Uri "http://localhost:18080/internal/integrations/telegram" -Headers @{ "X-Integration-Service-Key" = $AdminTelegramToken }
Write-Host "ADMIN=OK / encrypted store reachable" -ForegroundColor Green
Write-Host "HELIUS=$heliusStatus (active keys: $($internalHelius.count))"
Write-Host "TELEGRAM_CONTROL_PLANE credentials=$($internalTelegram.credentials_configured) session=$($internalTelegram.session_configured)"

Step "Verify Telegram MTProto session directly"
$telegramStatus = "MISSING"
if ($tgId -and $tgHash -and $tgSession) {
  $oldId = $env:TG_API_ID; $oldHash = $env:TG_API_HASH; $oldSession = $env:TG_SESSION_STRING
  try {
    $env:TG_API_ID = $tgId; $env:TG_API_HASH = $tgHash; $env:TG_SESSION_STRING = $tgSession
    $code = @'
import asyncio, os
from telethon import TelegramClient
from telethon.sessions import StringSession
async def main():
    c = TelegramClient(StringSession(os.environ["TG_SESSION_STRING"]), int(os.environ["TG_API_ID"]), os.environ["TG_API_HASH"])
    await c.connect()
    ok = await c.is_user_authorized()
    print("TG_AUTHORIZED=" + ("true" if ok else "false"))
    await c.disconnect()
asyncio.run(main())
'@
    $tgResult = (& $BackendPython -c $code 2>&1 | Out-String).Trim()
    $telegramStatus = if ($tgResult -match "TG_AUTHORIZED=true") { "AUTHORIZED" } else { "NOT_AUTHORIZED" }
  } catch { $telegramStatus = "FAILED" }
  finally {
    $env:TG_API_ID = $oldId; $env:TG_API_HASH = $oldHash; $env:TG_SESSION_STRING = $oldSession
  }
}
Write-Host "TELEGRAM=$telegramStatus"

Step "Start Backend, Intelligence API/worker and Frontend"
$processes.backend = (Start-Process powershell.exe -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", $BackendRunner) -PassThru -WindowStyle Minimized).Id
$processes.ai = (Start-Process powershell.exe -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", $AiRunner) -PassThru -WindowStyle Minimized).Id
$processes.worker = (Start-Process powershell.exe -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", $WorkerRunner) -PassThru -WindowStyle Minimized).Id
$processes.frontend = (Start-Process powershell.exe -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", $FrontendRunner) -PassThru -WindowStyle Minimized).Id
$processes | ConvertTo-Json | Set-Content -LiteralPath $PidFile -Encoding UTF8

$backendOk = Wait-Http "http://localhost:18000/health" 45
$aiOk = Wait-Http "http://localhost:3101/api/telegram-ai/status" 60
$frontendOk = Wait-Http "http://localhost:3100/trade/analysis/social?mint=$Mint" 60
$qwenHealth = $false
if ($realQwen) { $qwenHealth = Wait-Http "http://localhost:8002/health" 90 }
Write-Host "BACKEND=$(if ($backendOk) { 'OK' } else { 'FAILED' })"
Write-Host "INTELLIGENCE_API=$(if ($aiOk) { 'OK' } else { 'FAILED' })"
Write-Host "FRONTEND=$(if ($frontendOk) { 'OK' } else { 'FAILED' })"
Write-Host "QWEN_HEALTH=$(if ($realQwen) { if ($qwenHealth) { 'OK' } else { 'FAILED' } } else { 'MOCK' })"

Step "Real chart and blockchain smoke"
$chartStatus = "FAILED"
try {
  $chart = Invoke-RestMethod -Uri "http://localhost:3100/api/token-history?mint=$Mint&tf=1m" -TimeoutSec 45
  $count = @($chart.candles).Count
  $source = [string]$chart.source
  if (-not $source -and $chart.mock) { $source = "mock" }
  $chartStatus = if ($count -gt 0 -and -not $chart.mock) { "OK source=$source candles=$count" } elseif ($count -gt 0) { "MOCK candles=$count" } else { "NO_CANDLES" }
} catch { $chartStatus = "FAILED" }
Write-Host "CHART=$chartStatus"

$blockchainStatus = "FAILED"
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:3100/api/trade/analyze-stream?mint=$Mint&refresh=1" -TimeoutSec 180
  if ($r.StatusCode -eq 401 -or $r.StatusCode -eq 403) { $blockchainStatus = "AUTH_REQUIRED" }
  elseif ($r.Content -match '"type":"final"') { $blockchainStatus = "OK" }
  elseif ($r.Content -match '"type":"error"') { $blockchainStatus = "API_ERROR" }
  else { $blockchainStatus = "NO_FINAL_EVENT" }
} catch {
  if ($_.Exception.Response -and ([int]$_.Exception.Response.StatusCode -in @(401,403))) { $blockchainStatus = "AUTH_REQUIRED" } else { $blockchainStatus = "FAILED" }
}
Write-Host "BLOCKCHAIN=$blockchainStatus"

Step "Qwen inference smoke"
$qwenStatus = if ($realQwen) { "FAILED" } else { "MOCK" }
if ($aiOk) {
  try {
    $payload = @{
      messages = @(@{
        id = "smoke-1"; channelId = "smoke"; channelUsername = "smoke"; channelTitle = "Smoke"; senderId = $null;
        text = "Token discussion smoke test. Return a concise grounded assessment."; sentAt = (Get-Date).ToUniversalTime().ToString("o"); editedAt = $null;
        views = 1; forwards = 0; reactions = 0; replyToMessageId = $null; links = @()
      })
      context = @{ tokenAddress = $Mint; symbol = "SMOKE"; tokenName = "Smoke"; analysisMode = "telegram_only" }
      persist = $false
    } | ConvertTo-Json -Depth 8
    $qwen = Invoke-RestMethod -Uri "http://localhost:3101/api/telegram-ai/analyze" -Method Post -ContentType "application/json" -Body $payload -TimeoutSec 240
    $provider = [string]$qwen.provider
    $model = [string]$qwen.model
    if ($realQwen -and ($provider -or $model)) { $qwenStatus = "OK provider=$provider model=$model" }
    elseif (-not $realQwen) { $qwenStatus = "MOCK provider=$provider model=$model" }
  } catch { $qwenStatus = "FAILED" }
}
Write-Host "QWEN=$qwenStatus"

Step "Smoke summary"
Write-Host "HEAD=$(git -C $RepoRoot rev-parse --short HEAD)"
Write-Host "BUILD=OK"
Write-Host "ADMIN=OK"
Write-Host "HELIUS=$heliusStatus"
Write-Host "TELEGRAM=$telegramStatus"
Write-Host "QWEN=$qwenStatus"
Write-Host "CHART=$chartStatus"
Write-Host "BLOCKCHAIN=$blockchainStatus"
Write-Host ""
Write-Host "Social analysis: http://localhost:3100/trade/analysis/social?mint=$Mint" -ForegroundColor Yellow
Write-Host "Admin integrations: http://localhost:18080  (local smoke login: admin / local-smoke-only)" -ForegroundColor Yellow
Write-Host "Processes stay running. PID file: $PidFile"

Start-Process "http://localhost:3100/trade/analysis/social?mint=$Mint"
Start-Process "http://localhost:18080"
