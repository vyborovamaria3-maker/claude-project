# Telegram Mini App development tunnel
# Exposes the Next.js app that owns /miniapp and /api/miniapp/*.
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $repoRoot 'solana-launcher'

if (-not (Test-Path (Join-Path $appDir 'package.json'))) {
    throw "solana-launcher/package.json was not found."
}
if (-not (Test-Path (Join-Path $appDir 'node_modules'))) {
    throw "Install dependencies first: cd solana-launcher; npm ci --legacy-peer-deps"
}

$running = $false
try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/miniapp' -TimeoutSec 2 -UseBasicParsing
    $running = $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
} catch {
    $running = $false
}

if (-not $running) {
    Write-Host 'Starting Next.js Mini App/API on port 3000...' -ForegroundColor Yellow
    Start-Process -WindowStyle Minimized -FilePath 'cmd.exe' -WorkingDirectory $appDir -ArgumentList '/c', 'npm run dev'
    Start-Sleep -Seconds 8
}

Write-Host 'Starting a public development tunnel to port 3000.' -ForegroundColor Yellow
Write-Host 'Use test data only. Copy the HTTPS URL and append /miniapp to WEBAPP_URL.' -ForegroundColor Green
Set-Location $PSScriptRoot
npx localtunnel --port 3000
