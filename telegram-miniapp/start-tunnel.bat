@echo off
setlocal
chcp 65001 >nul

set "ROOT=%~dp0"
for %%I in ("%ROOT%..\solana-launcher") do set "APP_DIR=%%~fI"

if not exist "%APP_DIR%\package.json" (
  echo [ERROR] solana-launcher package.json was not found.
  exit /b 1
)
if not exist "%APP_DIR%\node_modules" (
  echo [ERROR] Install the solana-launcher dependencies first:
  echo   cd solana-launcher ^&^& npm ci --legacy-peer-deps
  exit /b 1
)

powershell -NoProfile -Command "try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/miniapp' -TimeoutSec 2 -UseBasicParsing; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  echo Starting the Next.js Mini App/API on port 3000...
  start "POTAPoff Mini App and API" cmd /k "cd /d ""%APP_DIR%"" && npm run dev"
  timeout /t 8 /nobreak >nul
)

echo Exposing the Next.js app, including /miniapp and its API routes.
echo Use only test data. The tunnel is public.
echo.
npx localtunnel --port 3000
pause
