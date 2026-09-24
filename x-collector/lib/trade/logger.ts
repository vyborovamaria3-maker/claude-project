import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { getConfig } from "./config";

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

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

let stream: fs.WriteStream | null = null;
let bytes = 0;
let currentPath = "";

function ensureStream(): fs.WriteStream {
  if (stream) return stream;
  const cfg = getConfig();
  const dir = path.join(process.cwd(), cfg.logging.dir);
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  currentPath = path.join(dir, `app-${date}.log`);
  bytes = fs.existsSync(currentPath) ? fs.statSync(currentPath).size : 0;
  stream = fs.createWriteStream(currentPath, { flags: "a" });
  return stream;
}

function rotate() {
  const cfg = getConfig();
  if (bytes < cfg.logging.rotateMaxBytes) return;
  stream?.end();
  stream = null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  try { fs.renameSync(currentPath, `${currentPath}.${ts}`); } catch {}
  bytes = 0;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  const cfg = getConfig();
  if (LEVELS[level] < LEVELS[(cfg.logging.level as Level) ?? "info"]) return;
  const entry = { ts: new Date().toISOString(), level, msg, ...getContext(), ...(meta ?? {}) };
  const line = JSON.stringify(entry) + "\n";
  ensureStream().write(line);
  bytes += line.length;
  rotate();

  const colors: Record<Level, string> = {
    debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m",
  };
  const reset = "\x1b[0m";
  const ctx = getContext();
  const ctxStr = [ctx.taskId && `task=${ctx.taskId}`, ctx.handle && `@${ctx.handle}`, ctx.workerId && `w=${ctx.workerId}`]
    .filter(Boolean).join(" ");
  const metaStr = meta && Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
  process.stderr.write(`${colors[level]}[${level}]${reset}${ctxStr ? " " + ctxStr : ""} ${msg}${metaStr}\n`);
}

export const log = {
  debug: (m: string, meta?: Record<string, unknown>) => emit("debug", m, meta),
  info: (m: string, meta?: Record<string, unknown>) => emit("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit("error", m, meta),
};

