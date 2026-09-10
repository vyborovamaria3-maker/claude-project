param(
    [int]$FrontendPort = 3002,
    [switch]$RealQwen,
    [switch]$SkipInfrastructure
)

$ErrorActionPreference = "Stop"
$LauncherRoot = Split-Path $PSScriptRoot -Parent
$RepoRoot = Split-Path $LauncherRoot -Parent
$IntelligenceRoot = Join-Path $RepoRoot "memecoin-intelligence"
$IntelligenceManagedByCompose = $false

function Test-LocalPort([int]$Port) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $task = $client.ConnectAsync("127.0.0.1", $Port)
        if (-not $task.Wait(350)) {
            $client.Dispose()
            return $false
        }
        $connected = $client.Connected
        $client.Dispose()
        return $connected
    } catch {
        return $false
    }
}

function Start-DevWindow([string]$Title, [string]$WorkingDirectory, [string]$Command) {
    $escapedDirectory = $WorkingDirectory.Replace("'", "''")
    $escapedTitle = $Title.Replace("'", "''")
    $fullCommand = "`$Host.UI.RawUI.WindowTitle='$escapedTitle'; Set-Location '$escapedDirectory'; $Command"
    Start-Process powershell -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $fullCommand) | Out-Null
}

Write-Host "POTAPoff Social Intelligence local stack" -ForegroundColor Cyan
Write-Host "Repo: $RepoRoot"
Write-Host ""

if (-not (Test-Path $IntelligenceRoot)) {
    throw "memecoin-intelligence directory not found: $IntelligenceRoot"
}
if (-not (Test-Path (Join-Path $LauncherRoot "backend\.env"))) {
    Write-Warning "backend/.env is missing. Telegram MTProto credentials/session will not be available until it is configured."
}
if (-not (Test-Path (Join-Path $IntelligenceRoot ".env"))) {
    Write-Warning "memecoin-intelligence/.env is missing. Compose requires it for a configured AI runtime."
}

if (-not $SkipInfrastructure) {
    Push-Location $IntelligenceRoot
    try {
        if ($RealQwen) {
            Write-Host "Starting Postgres, Redis, Intelligence API and real Qwen..." -ForegroundColor Cyan
            docker compose --profile ai up -d postgres redis qwen api
        } else {
            Write-Host "Starting Postgres, Redis and Intelligence API..." -ForegroundColor Cyan
            docker compose up -d postgres redis api
        }
        $IntelligenceManagedByCompose = $true
    } finally {
        Pop-Location
    }
}

if (Test-LocalPort 8000) {
    Write-Host "FastAPI 8000 already listening; leaving it untouched." -ForegroundColor Yellow
} else {
    Write-Host "Starting FastAPI on 8000..." -ForegroundColor Green
    Start-DevWindow "POTAPoff FastAPI :8000" $LauncherRoot "npm run backend:dev"
}

if ($IntelligenceManagedByCompose) {
    Write-Host "Memecoin Intelligence 3001 is managed by Docker Compose." -ForegroundColor Green
} elseif (Test-LocalPort 3001) {
    Write-Host "Memecoin Intelligence 3001 already listening; leaving it untouched." -ForegroundColor Yellow
} else {
    Write-Warning "3001 is not listening and -SkipInfrastructure was used. Start the configured Intelligence API manually or rerun without -SkipInfrastructure."
}

if (Test-LocalPort $FrontendPort) {
    Write-Host "Frontend $FrontendPort already listening; leaving it untouched." -ForegroundColor Yellow
} else {
    Write-Host "Starting Next frontend on $FrontendPort..." -ForegroundColor Green
    Start-DevWindow "POTAPoff Social :$FrontendPort" $LauncherRoot "npm run dev -- -p $FrontendPort"
}

Write-Host ""
Write-Host "Endpoints:" -ForegroundColor Cyan
Write-Host "  Frontend:     http://localhost:$FrontendPort/trade/analysis/social"
Write-Host "  FastAPI:      http://localhost:8000/health"
Write-Host "  Intelligence: http://localhost:3001/api/health"
Write-Host "  Qwen status:  http://localhost:3001/api/telegram-ai/status"
if ($RealQwen) {
    Write-Host "  Qwen service: http://localhost:8002/health"
}
Write-Host ""
Write-Host "After services are ready, run from solana-launcher:" -ForegroundColor Cyan
Write-Host "  npm run social:preflight -- <MINT>"
Write-Host ""
Write-Host "This launcher never stops or replaces an existing listener." -ForegroundColor DarkGray
