# Настройка Helius Webhook

## 1. Регистрация в Helius

1. Перейдите на https://www.helius.dev/
2. Зарегистрируйтесь / войдите
3. Получите API ключ в разделе Dashboard

## 2. Создание Webhook

В личном кабинете Helius:

**Webhook URL:**
```
https://your-backend-url.com/webhook/helius
```

Для локального тестирования используйте ngrok:
```bash
npx ngrok http 3001
```
Полученный URL (например `https://abc123.ngrok.io`) + `/webhook/helius`

**Account Addresses:**
- Добавьте ваш `MERCHANT_WALLET` адрес (куда будут приходить USDT)

**Transaction Types:**
- ☑️ NATIVE_TRANSFERS
- ☑️ TOKEN_TRANSFERS
- ☑️ ANY

**Webhook Secret (опционально):**
- Установите в поле "Webhook Secret"
- Добавьте в `.env`: `HELIUS_WEBHOOK_SECRET=your_secret`

## 3. Тестирование webhook локально

### Через ngrok:

```bash
# Терминал 1 - запуск ngrok
npx ngrok http 3001

# Получите URL типа https://abc123.ngrok.io
# Используйте: https://abc123.ngrok.io/webhook/helius
```

### Тест создания платежа:

```bash
# Терминал 2 - тест API
curl -X POST http://localhost:3001/api/subscription/create \
  -H "Content-Type: application/json" \
  -d '{"telegramId":123456789,"plan":"premium"}'
```

Ответ:
```json
{
  "success": true,
  "payUrl": "solana:YOUR_WALLET?amount=1000&spl-token=...&memo=123456789_...",
  "paymentId": "uuid",
  "memo": "123456789_1699999999999",
  "amount": 1000
}
```

### Тест webhook (mock):

```bash
# Используем скрипт
cd backend-new
npx ts-node scripts/test-webhook.ts 123456789_1699999999999
```

Или вручную:
```bash
curl -X POST http://localhost:3001/webhook/helius \
  -H "Content-Type: application/json" \
  -d '[{
    "signature": "5x...",
    "type": "TRANSFER",
    "memo": "123456789_1699999999999",
    "tokenTransfers": [{
      "mint": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      "toUserAccount": "YOUR_MERCHANT_WALLET",
      "fromUserAccount": "SENDER_WALLET",
      "tokenAmount": 1000
    }]
  }]'
```

## 4. Проверка подписки

```bash
npx ts-node scripts/check-subscription.ts 123456789
```

## 5. Полный flow тестирования

1. **Запустить бэкенд:** `npm run dev` (port 3001)
2. **Запустить ngrok:** `npx ngrok http 3001`
3. **Скопировать ngrok URL** в Helius webhook settings
4. **Открыть Mini App** в Telegram (http://localhost:5173 для локального теста)
5. **Нажать "Pay 1000 USDT"**
6. **Получить Solana Pay URL** открыть в Phantom/Solflare
7. **Выполнить тестовую транзакцию** (на devnet или mainnet)
8. **Helius отправит webhook** → подписка активируется
9. **Mini App определит** активную подписку через polling

## Продакшен деплой

### Backend (Render/Railway):
```env
PORT=3001
DATABASE_URL=postgresql://...
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
USDT_MINT=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
MERCHANT_WALLET=your_real_wallet_address
HELIUS_API_KEY=...
HELIUS_WEBHOOK_SECRET=...
FRONTEND_URL=https://your-frontend.vercel.app
TELEGRAM_BOT_TOKEN=...
```

### Helius Webhook URL:
```
https://your-backend.onrender.com/webhook/helius
```

### Frontend (Vercel):
```env
VITE_API_URL=https://your-backend.onrender.com
```

## Устранение неполадок

**Webhook не приходит:**
- Проверьте URL в Helius dashboard
- Проверьте MERCHANT_WALLET адрес
- Проверьте что бэкенд доступен извне (ngrok/деплой)

**Платёж не подтверждается:**
- Проверьте логи бэкенда
- Проверьте что memo в транзакции совпадает
- Проверьте что USDT mint правильный

**Mini App не видит подписку:**
- Проверьте console в браузере
- Проверьте polling каждые 5 секунд
- Обновите страницу
