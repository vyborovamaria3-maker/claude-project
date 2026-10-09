type Level = "info" | "warn" | "error";

function log(level: Level, message: string, data?: unknown) {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      data,
    })
  );
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
