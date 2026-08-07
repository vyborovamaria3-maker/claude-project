import { z } from 'zod';

const envBoolean = z.preprocess((value) => {
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  return value;
}, z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  SECURITY_HEADERS_STRICT: envBoolean.default(false),
  SECURITY_RBAC_ENABLED: envBoolean.default(false),
  INTERNAL_API_KEY: z.string().default(''),
  INTERNAL_ADMIN_API_KEY: z.string().default(''),
  INTERNAL_USER_API_KEY: z.string().default(''),
  DATABASE_URL: z.string().default('postgresql://memecoin:memecoin@localhost:5432/memecoin'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  DATA_PROVIDER: z.enum(['fixture', 'twitterapi', 'x-api']).default('fixture'),
  FIXTURE_PATH: z.string().default('./fixtures/x-posts.json'),
  TWITTERAPI_IO_KEY: z.string().default(''),
  X_BEARER_TOKEN: z.string().default(''),
  SEARCH_PAGES: z.coerce.number().int().min(1).max(5).default(2),
  SEARCH_CACHE_SECONDS: z.coerce.number().int().min(0).max(86400).default(300),
  MAX_SEARCH_RESULTS: z.coerce.number().int().min(1).max(5000).default(500),
  DB_POOL_MAX: z.coerce.number().int().min(2).max(200).default(20),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
  ANALYSIS_MAX_CANDIDATE_PAIRS: z.coerce.number().int().min(1000).max(5000000).default(300000),
  ANALYSIS_MAX_FEATURE_FANOUT: z.coerce.number().int().min(10).max(5000).default(180),
  ANALYSIS_TIME_BUCKET_MINUTES: z.coerce.number().int().min(1).max(120).default(5),
  INGEST_BATCH_SIZE: z.coerce.number().int().min(100).max(50000).default(5000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  TELEGRAM_AI_ENABLED: envBoolean.default(false),
  TELEGRAM_AI_MODE: z.enum(['mock', 'openai-compatible']).default('mock'),
  TELEGRAM_AI_BASE_URL: z.string().url().default('http://localhost:8000/v1'),
  TELEGRAM_AI_API_KEY: z.string().default(''),
  TELEGRAM_AI_MODEL: z.string().min(1).default('Qwen/Qwen2.5-7B-Instruct'),
  TELEGRAM_AI_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(900_000).default(180_000),
  TELEGRAM_AI_MAX_MESSAGES: z.coerce.number().int().min(1).max(500).default(60),
  TELEGRAM_AI_MAX_CHARS: z.coerce.number().int().min(1_000).max(1_000_000).default(24_000),
  TELEGRAM_AI_MAX_TOKENS: z.coerce.number().int().min(64).max(8_192).default(1_200),
  TELEGRAM_AI_TEMPERATURE: z.coerce.number().min(0).max(1.5).default(0.1),
  TELEGRAM_AI_CACHE_SECONDS: z.coerce.number().int().min(0).max(2_592_000).default(604_800),
  TELEGRAM_AI_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
});

const parsedEnv = schema.parse(process.env);

if (parsedEnv.NODE_ENV === 'production') {
  if (!parsedEnv.SECURITY_HEADERS_STRICT) {
    throw new Error('SECURITY_HEADERS_STRICT must be enabled in production');
  }
  if (!parsedEnv.SECURITY_RBAC_ENABLED) {
    throw new Error('SECURITY_RBAC_ENABLED must be enabled in production');
  }
  if (!parsedEnv.INTERNAL_ADMIN_API_KEY && !parsedEnv.INTERNAL_API_KEY) {
    throw new Error('INTERNAL_ADMIN_API_KEY or INTERNAL_API_KEY is required in production');
  }
}

export const env = parsedEnv;

// Backward-compatible export for callers that still use securityConfig.
export const securityConfig = {
  sessionSecret: process.env.SESSION_SECRET || '',
  apiKey: env.INTERNAL_API_KEY,
};
