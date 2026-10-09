import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { getConfig } from "./config";

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const PROCESS_TOKEN = `${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}`;
const SENSITIVE_KEY = /(token|password|secret|session|cookie|authorization|master.?key|api.?key|credentials|proxy|jwt|encryption.?key)/i;

export interface LogContext {
  taskId?: number;
  workerId?: string;
  mint?: string;
  handle?: string;
  session?: string;
  runId?: number;
}

const als = new AsyncLocalStorage<LogContext>();

export function withContext<T>(ctx: LogContext, fn: () => T): T {
  return als.run({ ...als.getStore(), ...ctx }, fn);
}
export function setContext(patch: LogContext) {
  const s = als.getStore();
  if (s) Object.assign(s, patch);
}
export function getContext(): LogContext { return als.getStore() ?? {}; }

let fd: number | null = null;
let currentPath = "";
let currentDate = "";
let bytesWritten = 0;

/** Вырезает поля, похожие на секреты, и ограничивает глубину/длину значений. */
export function scrub(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (depth > 6) return "[DEPTH_LIMIT]";
  if (Array.isArray(value)) return value.map((item) => scrub(item, key, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, scrub(v, k, depth + 1)]));
  }
  if (typeof value === "string") return value.length > 20_000 ? `${value.slice(0, 20_000)}…[TRUNCATED]` : value;
  return value;
}

function logPath(date: string): string {
  return path.join(process.cwd(), getConfig().logging.dir, `app-${date}-${PROCESS_TOKEN}.log`);
}

function ensureFile() {
  const cfg = getConfig();
  const date = new Date().toISOString().slice(0, 10);
  if (fd !== null && date === currentDate) return;
  if (fd !== null) fs.closeSync(fd);
  const dir = path.join(process.cwd(), cfg.logging.dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  currentDate = date;
  currentPath = logPath(date);
  fd = fs.openSync(currentPath, "a", 0o600);
  bytesWritten = fs.fstatSync(fd).size;
}

function rotateIfNeeded(incomingBytes: number) {
  ensureFile();
  if (fd === null) return;
  const cfg = getConfig();
  const onDiskBytes = fs.fstatSync(fd).size;
  bytesWritten = Math.max(bytesWritten, onDiskBytes);
  if (bytesWritten + incomingBytes <= cfg.logging.rotateMaxBytes) return;

  const oldPath = currentPath;
  fs.closeSync(fd);
  fd = null;
  try {
    fs.renameSync(oldPath, `${oldPath}.${Date.now()}.${randomUUID().slice(0, 8)}`);
  } catch (error) {
    process.stderr.write(`[logger] rotation failed: ${String(error)}\n`);
  }
  fd = fs.openSync(currentPath, "a", 0o600);
  bytesWritten = fs.fstatSync(fd).size;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  const cfg = getConfig();
  if (LEVELS[level] < LEVELS[(cfg.logging.level as Level) ?? "info"]) return;
  const safeMeta = meta ? scrub(meta) as Record<string, unknown> : undefined;
  const safeContext = scrub(getContext()) as LogContext;
  const entry = { ts: new Date().toISOString(), level, msg, ...safeContext, ...(safeMeta ?? {}) };
  const line = JSON.stringify(entry) + "\n";
  try {
    rotateIfNeeded(Buffer.byteLength(line));
    if (fd === null) ensureFile();
    if (fd !== null) {
      fs.writeSync(fd, line, undefined, "utf8");
      bytesWritten = fs.fstatSync(fd).size;
    }
  } catch (error) {
    process.stderr.write(`[logger] file write failed: ${String(error)}\n`);
  }

  const colors: Record<Level, string> = {
    debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m",
  };
  const reset = "\x1b[0m";
  const ctxStr = [safeContext.taskId && `task=${safeContext.taskId}`, safeContext.handle && `@${safeContext.handle}`, safeContext.workerId && `w=${safeContext.workerId}`]
    .filter(Boolean).join(" ");
  const metaStr = safeMeta && Object.keys(safeMeta).length ? " " + JSON.stringify(safeMeta) : "";
  process.stderr.write(`${colors[level]}[${level}]${reset}${ctxStr ? " " + ctxStr : ""} ${msg}${metaStr}\n`);
}

/** Закрывает файловый дескриптор лога (используется при graceful shutdown). */
export function closeLogger() {
  if (fd !== null) {
    fs.closeSync(fd);
    fd = null;
  }
}

export const log = {
  debug: (m: string, meta?: Record<string, unknown>) => emit("debug", m, meta),
  info: (m: string, meta?: Record<string, unknown>) => emit("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit("error", m, meta),
};
