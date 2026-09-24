import fs from "node:fs";
import path from "node:path";

export interface AppConfig {
  twitter: {
    strategy: "playwright";
    headless: boolean;
    searchLimit: number;
    timelineLimit: number;
    requestTimeoutMs: number;
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
  db: { vacuumAfterRuns: number; archiveAfterDays: number };
  notifications: {
    telegram: { enabled: boolean; botToken: string; chatId: string };
    webhook: { enabled: boolean; url: string };
  };
}

let cached: AppConfig | null = null;

export function loadConfig(p?: string): AppConfig {
  if (cached) return cached;
  const file = p ?? path.join(process.cwd(), "config", "default.json");
  if (!fs.existsSync(file)) throw new Error(`Config not found: ${file}`);
  const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as AppConfig;

  if (process.env.LOG_LEVEL) cfg.logging.level = process.env.LOG_LEVEL;
  if (process.env.TG_BOT_TOKEN) {
    cfg.notifications.telegram.enabled = true;
    cfg.notifications.telegram.botToken = process.env.TG_BOT_TOKEN;
  }
  if (process.env.TG_CHAT_ID) cfg.notifications.telegram.chatId = process.env.TG_CHAT_ID;

  cached = cfg;
  return cfg;
}

export function getConfig(): AppConfig {
  if (!cached) {
    try {
      loadConfig();
    } catch (e) {
      console.error("[config] failed to load, using defaults:", e);
      cached = {
        twitter: { strategy: "playwright", headless: true, searchLimit: 100, timelineLimit: 300,
          requestTimeoutMs: 60_000, maxAttempts: 5, backoffBaseMs: 2000,
          userAgents: ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"] },
        sessions: { maxRequestsPerHour: 60, cooldownAfterRateLimitMs: 1_200_000,
          cooldownAfterCaptchaMs: 3_600_000, banAfterConsecutiveErrors: 3, leaseMs: 300_000 },
        queue: { accountTtlMs: 86_400_000, maxAttempts: 3 },
        logging: { level: "info", dir: "logs", rotateMaxBytes: 10_485_760 },
        db: { vacuumAfterRuns: 10, archiveAfterDays: 90 },
        notifications: { telegram: { enabled: false, botToken: "", chatId: "" },
          webhook: { enabled: false, url: "" } },
      };
    }
  }
  return cached!;
}

export function resetConfigCache() { cached = null; }

