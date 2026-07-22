# Telegram Mini App Premium Swap (demo)

## Что внутри
- Бот на aiogram 3 + SQLite + bcrypt (логин 32 символа, пароль в хэше)
- Демо-оплата 1000 USDT с выбором сети (mock), выдача логина
- Watchlist + быстрый swap-просмотр (mock)
- Фронтенд: Vite + React + TS + Tailwind + framer-motion + lucide, Telegram WebApp SDK, темы RU/EN

## Запуск фронтенда (Vite)
```bash
cd frontend
npm install
npm run dev
```
Задеплойте на Vercel/Netlify, URL вставьте в WEBAPP_URL и в BotFather (/setdomain).

## Запуск бота (polling)
```bash
cd backend
python -m venv .venv
. .venv/bin/activate  # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
export BOT_TOKEN=... WEBAPP_URL=https://your-frontend.example.com
python bot.py
```

## Webhook через ngrok (опционально)
```bash
ngrok http 8080
export WEBHOOK_URL=https://<ngrok-id>.ngrok.io/webhook
python bot.py
```
В BotFather: /setdomain -> ваш https домен (ngrok/VPS). 

## Docker
```bash
cd backend
docker build -t tg-miniapp .
docker run -e BOT_TOKEN=... -e WEBAPP_URL=... -p 8080:8080 tg-miniapp
# либо docker compose
```

## Протокол WebAppData
- payment: {action:'payment', amount_usdt:1000, network:'Solana'}
- access: {action:'access', password:'...'}
- watchlist: {action:'watchlist', symbol:'SOL', note:'...'}
- create: {action:'create', title:'...', description:'...'}

## Переменные окружения
- BOT_TOKEN — токен бота
- WEBAPP_URL — URL фронтенда
- WEBHOOK_URL — опционально, если webhook
- DATABASE_PATH — путь к SQLite (miniapp.db по умолчанию)
- WEBAPP_HOST, WEBAPP_PORT — для webhook-сервера

## Замечания
- Оплата — mock, без Telegram Payments. Для реальной оплаты нужен provider token.
- SQLite подходит для прототипа. Для продакшена используйте Postgres.
- HTTPS обязателен для Mini App. 
```
