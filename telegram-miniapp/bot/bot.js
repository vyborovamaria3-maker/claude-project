const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

function requireEnv(name) {
  const value = process.env[name] && process.env[name].trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const BOT_TOKEN = requireEnv('BOT_TOKEN');
const WEBAPP_URL = requireEnv('WEBAPP_URL');

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log('🤖 Bot started');
console.log('📱 WebApp URL:', WEBAPP_URL);

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

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;

  await bot.sendMessage(
    chatId,
    `🔍 Проверка статуса подписки...\n\nUser ID: <code>${userId}</code>\n\nОткройте Mini App для подробной информации.`,
    { parse_mode: 'HTML' }
  );
});

bot.on('message', async (msg) => {
  if (msg.web_app_data) {
    console.log('📩 WebApp data received');

    try {
      const data = JSON.parse(msg.web_app_data.data);

      if (data.action === 'payment_initiated') {
        await bot.sendMessage(
          msg.chat.id,
          '💳 Платёж создан!\n\nПожалуйста, завершите оплату в вашем кошельке.\nПосле подтверждения подписка активируется автоматически.'
        );
      }
    } catch {
      console.log('Failed to parse WebApp data');
    }
  }
});

bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

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
