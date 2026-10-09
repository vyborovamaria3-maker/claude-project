$ErrorActionPreference = "Stop"

$project = "C:\Users\Рафаил\claude-project\memecoin-intelligence"
if (!(Test-Path $project)) {
    Write-Host "PROJECT_NOT_FOUND=$project" -ForegroundColor Red
    exit 1
}
Set-Location $project

$envFile = Join-Path $project ".env"
if (!(Test-Path $envFile)) {
    Write-Host "ENV_FILE_MISSING" -ForegroundColor Red
    exit 2
}

$lines = @(Get-Content -LiteralPath $envFile)
$raw = $lines -join "`n"

if ($raw -notmatch '(?m)^TOOKEN_API_KEY=\S+$') {
    Write-Host "TOOKEN_API_KEY=MISSING" -ForegroundColor Red
    Write-Host "Keep the key private. Add it to memecoin-intelligence\.env, then run this script again."
    exit 3
}

function Set-EnvLine([string[]]$content, [string]$name, [string]$value) {
    $found = $false
    $result = foreach ($line in $content) {
        if ($line -match ('^' + [regex]::Escape($name) + '=')) {
            if (!$found) { "$name=$value"; $found = $true }
        } else {
            $line
        }
    }
    if (!$found) { $result += "$name=$value" }
    return @($result)
}

$lines = Set-EnvLine $lines "TELEGRAM_AI_ENABLED" "true"
$lines = Set-EnvLine $lines "TELEGRAM_AI_PROVIDER" "tooken"
$lines = Set-EnvLine $lines "TELEGRAM_AI_FALLBACK_PROVIDER" "qwen"
$lines | Set-Content -LiteralPath $envFile -Encoding utf8

Write-Host "AI_ENV_CONFIGURED" -ForegroundColor Green

docker compose up -d --force-recreate api worker
if ($LASTEXITCODE -ne 0) { exit 4 }

Start-Sleep -Seconds 3
try {
    $status = Invoke-RestMethod ("http://" + "127.0.0.1:3001/api/telegram-ai/status") -TimeoutSec 15
    "AI_ENABLED=$($status.enabled)"
    "AI_PROVIDER=$($status.inference.provider)"
    "AI_CONFIGURED=$($status.inference.configured)"
    "AI_REACHABLE=$($status.inference.reachable)"
    "AI_MODEL=$($status.inference.model)"
} catch {
    Write-Host "AI_STATUS_FAILED=$($_.Exception.Message)" -ForegroundColor Red
    exit 5
}
