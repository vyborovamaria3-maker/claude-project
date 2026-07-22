import { loadEnvConfig } from '@next/env';
import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import { setupAgentHandlers } from './handlers/agents';
import { setupTaskHandlers } from './handlers/tasks';
import { setupStatusHandlers } from './handlers/status';
import { setupSubscriptionHandlers } from './handlers/subscription';
import { loggingMiddleware } from './middleware/logging';
import { sessionMiddleware } from './middleware/session';

loadEnvConfig(process.cwd());
dotenv.config({ path: '.env', override: false });
dotenv.config({ path: '.env.local', override: true });
dotenv.config({ path: '.env.development.local', override: true });

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  throw new Error('TELEGRAM_BOT_TOKEN is not set in environment variables');
}

const bot = new Telegraf(token);

bot.use(loggingMiddleware);
bot.use(sessionMiddleware);

setupAgentHandlers(bot);
setupTaskHandlers(bot);
setupStatusHandlers(bot);
setupSubscriptionHandlers(bot);

bot.catch((err, ctx) => {
  console.error(`Error for ${ctx.updateType}:`, err);
  ctx.reply('Something went wrong. Please try again later.');
});

async function startBot() {
  const frontendUrl = (
    process.env.FRONTEND_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3001"
  ).replace(/\/$/, "");
  const miniAppUrl = `${frontendUrl}/miniapp`;

  await bot.telegram.setChatMenuButton({
    menuButton: {
      type: "web_app",
      text: "Open Mini App",
      web_app: { url: miniAppUrl },
    },
  });

  if (process.env.NODE_ENV === 'production') {
    const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
    if (webhookUrl) {
      await bot.telegram.setWebhook(webhookUrl);
      console.log(`Webhook set to: ${webhookUrl}`);
    } else {
      console.warn('TELEGRAM_WEBHOOK_URL not set, webhook may not work properly');
    }
  } else {
    console.log('Starting Telegram bot in polling mode...');
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log('Telegram webhook cleared');
    bot.launch().catch((error) => {
      console.error('Telegram polling failed:', error);
      process.exit(1);
    });
    console.log('Bot started with polling');
  }
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

const isCliRun =
  process.env.npm_lifecycle_event === 'bot:dev' ||
  process.env.npm_lifecycle_event === 'bot:start' ||
  process.argv.some((arg) => /telegram-bot[\\/]+index\.ts$/.test(arg));

if (isCliRun) {
  startBot().catch((error) => {
    console.error('Failed to start Telegram bot:', error);
    process.exit(1);
  });
}

export { bot, startBot };
