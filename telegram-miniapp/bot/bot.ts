import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN || '8881301382:AAFoB52OPi5VredsbOE7F0mh_SBZubqabj8';
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-miniapp.vercel.app';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log('🤖 Bot started');
console.log('📱 WebApp URL:', WEBAPP_URL);

// Handle /start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from?.username || msg.from?.first_name || 'User';

  console.log(`👤 User ${username} (${msg.from?.id}) started the bot`);

  const welcomeMessage = `
👋 Привет, ${username}!

🚀 Добро пожаловать в Premium Trading Terminal

💎 Получите доступ к эксклюзивным функциям:
• Анализ токенов в реальном времени
• Продвинутые торговые инструменты
• Приоритетная поддержка
• Доступ на 1 год

💰 Стоимость: 1000 USDT (оплата через Solana Pay)

Нажмите кнопку ниже, чтобы открыть приложение:
  `.trim();

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '🚀 Открыть Premium App',
            web_app: { url: WEBAPP_URL }
          }
        ],
        [
          {
            text: '💬 Поддержка',
            url: 'https://t.me/support'
          }
        ]
      ]
    }
  };

  await bot.sendMessage(chatId, welcomeMessage, keyboard);
});

// Handle /help command
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  
  const helpMessage = `
❓ <b>Как пользоваться:</b>

1️⃣ Нажмите "🚀 Открыть Premium App"
2️⃣ Нажмите "Pay 1000 USDT"
3️⃣ Подтвердите оплату в Phantom/Solflare
4️⃣ Подписка активируется автоматически!

⚡️ Платёж проходит через Solana Pay — быстро и безопасно.
  `.trim();

  await bot.sendMessage(chatId, helpMessage, { parse_mode: 'HTML' });
});

// Handle /status command
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  await bot.sendMessage(
    chatId,
    `🔍 Проверка статуса подписки...\n\nUser ID: <code>${userId}</code>\n\nОткройте Mini App для подробной информации.`,
    { parse_mode: 'HTML' }
  );
});

// Handle web_app_data (when user sends data from Mini App)
bot.on('message', async (msg) => {
  if (msg.web_app_data) {
    console.log('📩 WebApp data received:', msg.web_app_data);
    
    try {
      const data = JSON.parse(msg.web_app_data.data);
      
      if (data.action === 'payment_initiated') {
        await bot.sendMessage(
          msg.chat.id,
          `💳 Платёж создан!\n\nПожалуйста, завершите оплату в вашем кошельке.\nПосле подтверждения подписка активируется автоматически.`
        );
      }
    } catch (e) {
      console.log('Failed to parse WebApp data');
    }
  }
});

// Handle errors
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Stopping bot...');
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Stopping bot...');
  bot.stopPolling();
  process.exit(0);
});

console.log('✅ Bot is running and waiting for messages...');
