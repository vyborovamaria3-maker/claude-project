@echo off
cd /d C:\Users\Рафаил\claude-project\telegram-miniapp\backend
start "TG-Bot" C:\Users\Рафаил\claude-project\telegram-miniapp\backend\.venv\Scripts\python.exe C:\Users\Рафаил\claude-project\telegram-miniapp\backend\bot.py

cd /d C:\Users\Рафаил\claude-project\telegram-miniapp\frontend
set PATH=C:\Users\Рафаил\PotaPowLR\node-v22.22.3-win-x64;%PATH%
start "TG-Frontend" cmd /c "node node_modules\vite\bin\vite.js --host --port 5173"

echo Both started.
pause
