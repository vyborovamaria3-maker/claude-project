type Level = "info" | "warn" | "error";
import { log as sharedLog } from "../../lib/trade/logger";

function log(level: Level, message: string, data?: unknown) {
  sharedLog[level](message, { data: data instanceof Error ? { error: data.message } : data });
}

export const logger = {
  info(message: string, data?: unknown) {
    log("info", message, data);
  },
  warn(message: string, data?: unknown) {
    log("warn", message, data);
  },
  error(message: string, data?: unknown) {
    log("error", message, data);
  },
};
