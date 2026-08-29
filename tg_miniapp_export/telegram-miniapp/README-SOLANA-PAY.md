# Telegram Mini App + Solana Pay (USDT)

Telegram Mini App с оплатой подписки через Solana Pay (1000 USDT на 1 год).

## Архитектура

```
telegram-miniapp/
├── backend-new/          # Node.js + Express + Prisma + PostgreSQL
│   ├── src/
│   │   ├── config/       # Конфигурация
│   │   ├── controllers/  # API handlers
│   │   ├── services/     # Solana, DB логика
│   │   └── index.ts      # Express сервер
│   ├── prisma/schema.prisma  # User, Payment модели
│   └── .env.example
├── frontend/             # React + Vite (адаптирован)
│   ├── src/
│   │   ├── components/PayButton.tsx      # Кнопка оплаты
│   │   ├── components/SubscriptionStatus.tsx  # Статус подписки
│   │   ├── hooks/useSubscription.ts      # Проверка статуса
│   │   ├── lib/telegram.ts               # Telegram WebApp SDK
│   │   ├── lib/api.ts                    # API клиент
│   │   └── App.tsx                       # Основной компонент
│   └── .env.example
└── backend/            # Python бот (aiogram) - запуск Mini App
    └── bot.py
```

## Быстрый старт

### 1. Подготовка окружения

Создайте `.env` файлы:

**backend-new/.env:**
```env
PORT=3001
DATABASE_URL=postgresql://user:pass@localhost:5432/miniapp
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY
USDT_MINT=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
MERCHANT_WALLET=YOUR_SOLANA_WALLET_ADDRESS
HELIUS_API_KEY=your_helius_api_key
HELIUS_WEBHOOK_SECRET=your_webhook_secret
FRONTEND_URL=https://your-frontend.vercel.app
TELEGRAM_BOT_TOKEN=your_bot_token
```

**frontend/.env:**
```env
VITE_API_URL=https://your-backend.render.com
```

### 2. База данных

```bash
cd backend-new
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run dev
```

### 3. Фронтенд

```bash
cd frontend
npm install
npm run dev
```

### 4. Python бот (запуск Mini App)

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python bot.py
```

## Helius Webhook настройка

1. Зарегистрируйтесь на [helius.dev](https://helius.dev)
2. Создайте Webhook с URL: `https://your-backend.com/webhook/helius`
3. Выберите события: `NATIVE_TRANSFERS`, `TOKEN_TRANSFERS`
4. Укажите account address: ваш `MERCHANT_WALLET`

## Flow оплаты

1. Пользователь открывает Mini App из бота
2. Нажимает "Pay 1000 USDT"
3. Backend создает payment запись с unique memo
4. Открывается Solana Pay deep link (Phantom/Solflare)
5. Пользователь подтверждает транзакцию
6. Helius отправляет webhook на backend
7. Backend подтверждает платеж и активирует подписку (+365 дней)
8. Frontend определяет активную подписку через polling

## Проверка работы

- **Health check:** `GET http://localhost:3001/health`
- **Webhook health:** `GET http://localhost:3001/webhook/helius/health`
- **Create payment:** `POST http://localhost:3001/api/subscription/create`
- **Check status:** `GET http://localhost:3001/api/subscription/status?userId=123456`

## Деплой

### Backend (Render/Railway/DigitalOcean)
```bash
npm install
npm run build
npm start
```

### Frontend (Vercel)
```bash
npm install
npm run build
```

### Helius Webhook URL
```
https://your-backend.onrender.com/webhook/helius
```

## Безопасность

- ✅ Валидация Telegram initData на сервере (опционально)
- ✅ Проверка подписи Helius webhook
- ✅ HTTPS обязательно для production
- ✅ Отдельный merchant wallet (не основной!)
- ✅ Unique memo для каждого платежа

## Лимиты

- Цена фиксированная: 1000 USDT
- Подписка: 365 дней (1 год)
- Сеть: Solana Mainnet
- Токен: USDT (Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB)
