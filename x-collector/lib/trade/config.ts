import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export interface AppConfig {
  twitter: {
    strategy: "playwright";
    headless: boolean;
    searchLimit: number;
    timelineLimit: number;
    requestTimeoutMs: number;
    collectionDeadlineMs: number;
    maxAttempts: number;
    backoffBaseMs: number;
    userAgents: string[];
  };
  sessions: {
    maxRequestsPerHour: number;
    cooldownAfterRateLimitMs: number;
    cooldownAfterCaptchaMs: number;
    banAfterConsecutiveErrors: number;
    leaseMs: number;
  };
  queue: { accountTtlMs: number; maxAttempts: number };
  logging: { level: string; dir: string; rotateMaxBytes: number };
  db: {
    vacuumAfterRuns: number;
    archiveAfterDays: number;
    retryAttempts: number;
    retryBaseMs: number;
    retryMaxMs: number;
  };
  notifications: {
    telegram: { enabled: boolean; botToken: string; chatId: string };
    webhook: { enabled: boolean; url: string };
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  twitter: {
    strategy: "playwright", headless: true, searchLimit: 100, timelineLimit: 300,
    requestTimeoutMs: 60_000, collectionDeadlineMs: 180_000, maxAttempts: 5,
    backoffBaseMs: 2_000,
    userAgents: ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"],
  },
  sessions: {
    maxRequestsPerHour: 60, cooldownAfterRateLimitMs: 1_200_000,
    cooldownAfterCaptchaMs: 3_600_000, banAfterConsecutiveErrors: 3, leaseMs: 300_000,
  },
  queue: { accountTtlMs: 86_400_000, maxAttempts: 3 },
  logging: { level: "info", dir: "logs", rotateMaxBytes: 10_485_760 },
  db: { vacuumAfterRuns: 10, archiveAfterDays: 90, retryAttempts: 3, retryBaseMs: 100, retryMaxMs: 2_000 },
  notifications: {
    telegram: { enabled: false, botToken: "", chatId: "" },
    webhook: { enabled: false, url: "" },
  },
};

const ConfigSchema = z.object({
  twitter: z.object({
    strategy: z.literal("playwright"), headless: z.boolean(),
    searchLimit: z.number().int().min(1).max(1000),
    timelineLimit: z.number().int().min(1).max(2000),
    requestTimeoutMs: z.number().int().min(1000).max(600_000),
    collectionDeadlineMs: z.number().int().min(1000).max(900_000),
    maxAttempts: z.number().int().min(1).max(10),
    backoffBaseMs: z.number().int().min(10).max(300_000),
    userAgents: z.array(z.string().min(1)).min(1),
  }),
  sessions: z.object({
    maxRequestsPerHour: z.number().int().min(1).max(100_000),
    cooldownAfterRateLimitMs: z.number().int().min(0).max(86_400_000),
    cooldownAfterCaptchaMs: z.number().int().min(0).max(604_800_000),
    banAfterConsecutiveErrors: z.number().int().min(1).max(100),
    leaseMs: z.number().int().min(5_000).max(3_600_000),
  }),
  queue: z.object({
    accountTtlMs: z.number().int().min(60_000).max(31_536_000_000),
    maxAttempts: z.number().int().min(1).max(20),
  }),
  logging: z.object({
    level: z.enum(["debug", "info", "warn", "error"]),
    dir: z.string().min(1), rotateMaxBytes: z.number().int().min(64_000).max(1_073_741_824),
  }),
  db: z.object({
    vacuumAfterRuns: z.number().int().min(1).max(100_000),
    archiveAfterDays: z.number().int().min(1).max(36_500),
    retryAttempts: z.number().int().min(1).max(10),
    retryBaseMs: z.number().int().min(1).max(60_000),
    retryMaxMs: z.number().int().min(1).max(300_000),
  }),
  notifications: z.object({
    telegram: z.object({ enabled: z.boolean(), botToken: z.string(), chatId: z.string() }),
    webhook: z.object({ enabled: z.boolean(), url: z.string() }),
  }),
});

let cached: AppConfig | null = null;
let loadedFromFile = false;

/** Рекурсивно накладывает значения из файла на дефолты, не теряя поля при частичном конфиге. */
function mergeConfig(base: AppConfig, input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const result: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(source)) {
    const original = (base as unknown as Record<string, unknown>)[key];
    result[key] = original && typeof original === "object" && !Array.isArray(original)
      ? mergeConfig(original as AppConfig, value)
      : value;
  }
  return result;
}

export function loadConfig(p?: string): AppConfig {
  if (cached) return cached;
  const file = p ?? process.env.CONFIG_FILE ?? path.join(process.cwd(), "config", "default.json");
  if (!fs.existsSync(file)) throw new Error(`Config not found: ${file}`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const merged = mergeConfig(DEFAULT_CONFIG, raw) as Record<string, unknown>;

  const logging = merged.logging as Record<string, unknown>;
  const notifications = merged.notifications as { telegram: Record<string, unknown>; webhook: Record<string, unknown> };
  if (process.env.LOG_LEVEL) logging.level = process.env.LOG_LEVEL;
  if (process.env.LOG_DIR) logging.dir = process.env.LOG_DIR;
  if (process.env.TG_BOT_TOKEN) {
    notifications.telegram.enabled = true;
    notifications.telegram.botToken = process.env.TG_BOT_TOKEN;
  }
  if (process.env.TG_CHAT_ID) notifications.telegram.chatId = process.env.TG_CHAT_ID;
  if (process.env.WEBHOOK_URL) {
    notifications.webhook.enabled = true;
    notifications.webhook.url = process.env.WEBHOOK_URL;
  }

  cached = ConfigSchema.parse(merged) as AppConfig;
  loadedFromFile = true;
  return cached;
}

export function getConfig(): AppConfig {
  if (!cached) {
    try {
      loadConfig();
    } catch (e) {
      // Отсутствие/порча config/default.json раньше молча подменялась дефолтами.
      // Теперь это громко логируется, а окружение фиксируется флагом configLoadedFromFile.
      loadedFromFile = false;
      console.warn(JSON.stringify({
        level: "warn", msg: "Config file unavailable or invalid; using validated defaults",
        error: e instanceof Error ? e.message : String(e),
      }));
      cached = ConfigSchema.parse(DEFAULT_CONFIG) as AppConfig;
    }
  }
  return cached!;
}

export function configLoadedFromFile(): boolean { return loadedFromFile; }

export function resetConfigCache() {
  cached = null;
  loadedFromFile = false;
}
