@echo off
chcp 65001 >nul
echo ==========================================
echo   Telegram Mini App - HTTPS Tunnel
echo ==========================================
echo.
echo 1. Запускаем frontend...
start /min cmd /c "cd frontend && npm run dev"

echo 2. Ждем 5 секунд...
timeout /t 5 /nobreak >nul

echo 3. Запускаем HTTPS туннель...
echo.
cd frontend
npx localtunnel --port 5173

echo.
echo ==========================================
echo Скопируйте HTTPS URL выше
echo и вставьте в BotFather -
nene Settings -
nene Menu Button -
nene Specify URL
echo ==========================================
pause
