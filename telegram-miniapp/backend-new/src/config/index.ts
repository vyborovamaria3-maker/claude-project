import dotenv from 'dotenv';

dotenv.config();

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3001', 10),

  databaseUrl: process.env.DATABASE_URL!,

  solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  usdtMint: process.env.USDT_MINT || 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  merchantWallet: process.env.MERCHANT_WALLET!,

  heliusApiKey: process.env.HELIUS_API_KEY!,
  heliusWebhookSecret: process.env.HELIUS_WEBHOOK_SECRET!,

  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
};

function requireUrl(name: string, value: string) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

export function validateConfig() {
  const required = [
    'DATABASE_URL',
    'MERCHANT_WALLET',
    'HELIUS_API_KEY',
    'HELIUS_WEBHOOK_SECRET',
    'TELEGRAM_BOT_TOKEN',
  ];

  const missing = required.filter(key => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  if (!Number.isSafeInteger(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error('PORT must be between 1 and 65535');
  }
  if (config.heliusWebhookSecret.trim().length < 32) {
    throw new Error('HELIUS_WEBHOOK_SECRET must contain at least 32 characters');
  }
  if (config.telegramBotToken.trim().length < 20) {
    throw new Error('TELEGRAM_BOT_TOKEN is invalid or too short');
  }

  const frontend = requireUrl('FRONTEND_URL', config.frontendUrl);
  requireUrl('SOLANA_RPC_URL', config.solanaRpcUrl);
  if (config.nodeEnv === 'production' && frontend.protocol !== 'https:') {
    throw new Error('FRONTEND_URL must use HTTPS in production');
  }
}
