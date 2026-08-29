import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3001'),
  
  // Database
  databaseUrl: process.env.DATABASE_URL!,
  
  // Solana
  solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  usdtMint: process.env.USDT_MINT || 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  merchantWallet: process.env.MERCHANT_WALLET!,
  
  // Helius
  heliusApiKey: process.env.HELIUS_API_KEY!,
  heliusWebhookSecret: process.env.HELIUS_WEBHOOK_SECRET!,
  
  // Frontend
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  
  // Telegram
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
};

// Validate required env vars
export function validateConfig() {
  const required = [
    'DATABASE_URL',
    'MERCHANT_WALLET',
    'HELIUS_API_KEY',
    'HELIUS_WEBHOOK_SECRET',
    'TELEGRAM_BOT_TOKEN',
  ];
  
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}
