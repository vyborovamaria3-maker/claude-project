# Telegram Mini App - HTTPS Tunnel Setup
# Run this script to expose local frontend to internet

Write-Host "==========================================" -ForegroundColor Green
Write-Host "  Telegram Mini App - HTTPS Tunnel Setup  " -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""

# Check if frontend is running
Write-Host "1. Checking if frontend is running on port 5173..." -ForegroundColor Yellow
$frontendRunning = $false
try {
    $response = Invoke-WebRequest -Uri "http://localhost:5173" -TimeoutSec 2 -UseBasicParsing -ErrorAction SilentlyContinue
    if ($response.StatusCode -eq 200) {
        $frontendRunning = $true
        Write-Host "   ✓ Frontend is already running!" -ForegroundColor Green
    }
} catch {
    Write-Host "   ✗ Frontend not running, starting now..." -ForegroundColor Red
}

if (-not $frontendRunning) {
    Write-Host "   → Starting frontend..." -ForegroundColor Cyan
    Start-Process -WindowStyle Minimized powershell -ArgumentList "-Command cd frontend; npm run dev"
    Write-Host "   Waiting 5 seconds for startup..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}

Write-Host ""
Write-Host "2. Starting HTTPS tunnel..." -ForegroundColor Yellow
Write-Host "   (This will create a public HTTPS URL)" -ForegroundColor Gray
Write-Host ""
Write-Host "   Wait for the URL to appear below..." -ForegroundColor Cyan
Write-Host "   Copy the https://xxxxx.loca.lt URL" -ForegroundColor Green
Write-Host ""
Write-Host "==========================================" -ForegroundColor Magenta

# Change to frontend directory and start localtunnel
Set-Location frontend
try {
    npx localtunnel --port 5173
} catch {
    Write-Host "Error starting localtunnel: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "Alternative: Install cloudflared:" -ForegroundColor Yellow
    Write-Host "   1. Download from https://github.com/cloudflare/cloudflared/releases" -ForegroundColor Cyan
    Write-Host "   2. Run: cloudflared tunnel --url http://localhost:5173" -ForegroundColor Cyan
}
