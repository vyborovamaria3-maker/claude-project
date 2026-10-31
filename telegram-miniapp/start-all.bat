@echo off
setlocal
chcp 65001 >nul

set "ROOT=%~dp0"
for %%I in ("%ROOT%..\solana-launcher") do set "APP_DIR=%%~fI"
set "BOT_DIR=%ROOT%bot"

if not exist "%APP_DIR%\package.json" (
  echo [ERROR] solana-launcher package.json was not found.
  exit /b 1
)
if not exist "%APP_DIR%\node_modules" (
  echo [ERROR] Install the solana-launcher dependencies first:
  echo   cd solana-launcher ^&^& npm ci --legacy-peer-deps
  exit /b 1
)
if not exist "%BOT_DIR%\package.json" (
  echo [ERROR] telegram-miniapp\bot package.json was not found.
  exit /b 1
)
if not exist "%BOT_DIR%\node_modules" (
  echo [ERROR] Install bot dependencies first:
  echo   cd telegram-miniapp\bot ^&^& npm ci
  exit /b 1
)
if not exist "%BOT_DIR%\.env" (
  echo [ERROR] Copy bot\.env.example to bot\.env and set BOT_TOKEN and WEBAPP_URL.
  exit /b 1
)

echo Starting the current Next.js Mini App/API on port 3000...
start "POTAPoff Mini App and API" cmd /k "cd /d ""%APP_DIR%"" && npm run dev"

echo Starting the Node Telegram bot...
start "POTAPoff Telegram Bot" cmd /k "cd /d ""%BOT_DIR%"" && npm run dev"

echo.
echo Mini App page: http://localhost:3000/miniapp
echo The bot must use a publicly reachable HTTPS WEBAPP_URL ending in /miniapp.
echo For a temporary development tunnel, run start-tunnel.bat, update bot\.env,
echo then restart the bot. This script does not start the legacy Vite preview
echo or the separate backend-new Express experiment.
pause
