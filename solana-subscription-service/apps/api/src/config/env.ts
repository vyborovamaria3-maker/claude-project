import "dotenv/config";
import { z } from "zod";

const boolFromString = z.preprocess((value) => value === true || value === "true", z.boolean());
const intFromString = z.preprocess((value) => Number(value), z.number().int().positive());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: intFromString.default(4000),
  APP_NAME: z.string().default("SolSub"),
  WEB_ORIGIN: z.string().url(),
  API_PUBLIC_URL: z.string().url(),
  WEB_PUBLIC_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: intFromString.default(900),
  REFRESH_TOKEN_TTL_SECONDS: intFromString.default(60 * 60 * 24 * 30),
  COOKIE_DOMAIN: z.string().optional().default(""),
  COOKIE_SECURE: boolFromString.default(false),
  TELEGRAM_BOT_TOKEN: z.string().min(10),
  TELEGRAM_BOT_USERNAME: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(10),
  TELEGRAM_WEBAPP_URL: z.string().url(),
  SOLANA_CLUSTER: z.enum(["devnet", "testnet", "mainnet-beta"]).default("devnet"),
  RPC_ENDPOINT: z.string().url(),
  TREASURY_WALLET: z.string().min(32),
  TREASURY_USDC_TOKEN_ACCOUNT: z.string().min(32),
  USDC_MINT: z.string().min(32),
  PAYMENT_CONFIRMATION_COMMITMENT: z.enum(["confirmed", "finalized"]).default("confirmed"),
  HELIUS_WEBHOOK_AUTH_TOKEN: z.string().optional().default("")
});

export const env = envSchema.parse(process.env);

export const cookieConfig = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: "strict" as const,
  domain: env.COOKIE_DOMAIN || undefined,
  path: "/"
};
