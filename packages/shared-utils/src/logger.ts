const SECRET_KEY = /password|passwd|secret|token|authorization|cookie|session|credential|api.?key|private.?key/i;
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSink = (line: string) => void;

export function sanitizeForLog(input: unknown, depth = 0, visited = new WeakSet<object>()): unknown {
  if (typeof input === "string") return input.length > 2048 ? input.slice(0, 2048) + "[truncated]" : input;
  if (input === null || typeof input !== "object") return input;
  if (depth > 6) return "[depth-limited]";
  if (visited.has(input)) return "[cycle]";
  visited.add(input);
  if (Array.isArray(input)) {
    const array = input.slice(0, 100).map(x => sanitizeForLog(x, depth + 1, visited));
    visited.delete(input);
    return array;
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input).slice(0, 100)) {
    output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : sanitizeForLog(value, depth + 1, visited);
  }
  visited.delete(input);
  return output;
}

export function createLogger(subsystem: string, sink: LogSink = console.log) {
  if (!subsystem.trim()) throw new Error("subsystem is required");
  const log = (level: LogLevel, message: string, fields: Record<string, unknown> = {}) => {
    const payload = { timestamp: new Date().toISOString(), level, subsystem, message: message.slice(0, 2048), ...sanitizeForLog(fields) as Record<string, unknown> };
    sink(JSON.stringify(payload));
  };
  return {
    debug: (message: string, fields?: Record<string, unknown>) => log("debug", message, fields),
    info: (message: string, fields?: Record<string, unknown>) => log("info", message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => log("warn", message, fields),
    error: (message: string, fields?: Record<string, unknown>) => log("error", message, fields),
  };
}
