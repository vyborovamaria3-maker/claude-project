import { loadEnvConfig } from '@next/env';
import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import { setupAgentHandlers } from './handlers/agents';
import { setupTaskHandlers } from './handlers/tasks';
import { setupStatusHandlers } from './handlers/status';
import { setupSubscriptionHandlers } from './handlers/subscription';
import { loggingMiddleware } from './middleware/logging';
import { sessionMiddleware } from './middleware/session';

const { SocksProxyAgent } = require('socks-proxy-agent') as {
  SocksProxyAgent: new (url: string) => any;
};

loadEnvConfig(process.cwd());
dotenv.config({ path: '.env', override: false });
dotenv.config({ path: '.env.local', override: true });
dotenv.config({ path: '.env.development.local', override: true });

let botInstance: Telegraf | null = null;

function getBot(): Telegraf {
  if (botInstance) return botInstance;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set in environment variables');
  }

  const proxyUrl = process.env.TELEGRAM_PROXY_URL?.trim();
  const bot = proxyUrl
    ? new Telegraf(token, {
        telegram: {
          agent: new SocksProxyAgent(proxyUrl),
        },
      })
    : new Telegraf(token);

  if (proxyUrl) {
    console.log(`Telegram proxy enabled (${new URL(proxyUrl).protocol})`);
  }

  bot.use(loggingMiddleware);
  bot.use(sessionMiddleware);
  setupAgentHandlers(bot);
  setupTaskHandlers(bot);
  setupStatusHandlers(bot);
  setupSubscriptionHandlers(bot);
  bot.catch((err, ctx) => {
    console.error(`Error for ${ctx.updateType}:`, err);
    void ctx.reply('Something went wrong. Please try again later.');
  });

  botInstance = bot;
  return bot;
}

async function startBot() {
  const bot = getBot();
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
    if (!webhookUrl || !webhookUrl.startsWith('https://')) {
      throw new Error('TELEGRAM_WEBHOOK_URL must be a public HTTPS URL');
    }

    await bot.telegram.setMyCommands([
      { command: 'start', description: 'Open Mini App' },
      { command: 'subscribe', description: 'Open subscription' },
      { command: 'help', description: 'Show help' },
      { command: 'agents', description: 'List AI agents' },
      { command: 'tasks', description: 'List your tasks' },
    ]);
    await bot.telegram.setWebhook(webhookUrl, {
      secret_token: process.env.TELEGRAM_WEBHOOK_SECRET || undefined,
      allowed_updates: ['message', 'callback_query'],
    });
    console.log(`Webhook set to: ${webhookUrl}`);

    // Telegram sends updates to the Next.js webhook route. Keep this service
    // alive so Compose can monitor configuration/auth failures and restart it.
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
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

export { getBot, startBot };
