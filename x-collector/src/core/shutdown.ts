import { logger } from "./logger";

let shuttingDown = false;

export function setupShutdown(cleanup: () => Promise<void>) {
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.warn("shutdown requested", { signal });

    try {
      await cleanup();
    } catch (error) {
      logger.error("shutdown cleanup failed", error);
    }

    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
