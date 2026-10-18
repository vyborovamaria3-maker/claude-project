function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}: ${n}`);
  return n;
}
export const pollSeconds = envInt("TG_POLL_SECONDS", 300, 30, 86400);
export const batchSize = envInt("TG_BATCH_SIZE", 100, 1, 100);
export const maxPages = envInt("TG_MAX_PAGES_PER_JOB", 20, 1, 100);
export const initialLimit = envInt("TG_INITIAL_MESSAGE_LIMIT", 500, 1, 100000);
