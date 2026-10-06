import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const SOLANA_LAUNCHER_DIR = process.cwd();
const X_COLLECTOR_DIR_REL = path.join(SOLANA_LAUNCHER_DIR, "..", "x-collector");

const REQUIRED_MIGRATIONS = [
  "001_init.sql",
  "002_improvements.sql",
  "003_performance.sql",
  "004_analytics.sql",
  "005_nlp.sql",
  "006_events.sql",
  "007_kol.sql",
  "008_timeseries.sql",
  "009_advanced_analytics.sql",
  "010_predictive.sql",
  "011_runtime_hardening.sql",
] as const;

export type XCollectorAction =
  | "migrate"
  | "migrate-status"
  | "login"
  | "register-account"
  | "worker-start"
  | "worker-stop"
  | "scheduler-start"
  | "scheduler-stop"
  | "dashboard-start"
  | "dashboard-stop";

type ProcessRecord = { pid: number; startedAt: number; command: string };

export type XCollectorSummary = {
  installed: boolean;
  dirExists: boolean;
  nodeModulesPresent: boolean;
  env: {
    databaseUrlConfigured: boolean;
    masterKeyConfigured: boolean;
  };
  migrations: {
    complete: boolean;
    missing: string[];
    path: string;
  };
  processes: {
    worker: ProcessRecord | null;
    scheduler: ProcessRecord | null;
    dashboard: ProcessRecord | null;
  };
  health: {
    worker: { url: string; reachable: boolean; detail: string };
    dashboard: { url: string; reachable: boolean; detail: string };
  };
  db: {
    reachable: boolean;
    detail: string;
  };
};

function getXCollectorDir() {
  return path.resolve(X_COLLECTOR_DIR_REL);
}

function envValueConfigured(value: string | undefined) {
  return Boolean(value && value.trim().length > 0);
}

function parseDbHostPort(databaseUrl: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(databaseUrl);
    const host = parsed.hostname || "127.0.0.1";
    const port = Number(parsed.port || 5432);
    return { host, port };
  } catch {
    return null;
  }
}

async function probeDb(databaseUrl: string | undefined): Promise<{ reachable: boolean; detail: string }> {
  if (!databaseUrl) return { reachable: false, detail: "DATABASE_URL не задан" };
  const target = parseDbHostPort(databaseUrl);
  if (!target) return { reachable: false, detail: "Не удалось разобрать DATABASE_URL" };

  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ reachable: false, detail: `${target.host}:${target.port} — таймаут (3с)` });
    }, 3000);

    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ reachable: true, detail: `${target.host}:${target.port}` });
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ reachable: false, detail: `${target.host}:${target.port} — ${error.message}` });
    });
    socket.connect(target.port, target.host);
  });
}

function parseEnvFile(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, "utf-8");
  const env: Record<string, string> = {};
  content.split("\n").forEach((line) => {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) return;
    const [key, ...rest] = line.split("=");
    if (key && rest.length > 0) {
      env[key.trim()] = rest.join("=").trim().replace(/^["']|["']$/g, "");
    }
  });
  return env;
}

const managedProcesses = new Map<"worker" | "scheduler" | "dashboard", ProcessRecord>();

function resolveScript(name: "worker" | "scheduler" | "dashboard") {
  const map: Record<typeof name, string> = {
    worker: "worker.ts",
    scheduler: "scheduler.ts",
    dashboard: "dashboard.ts",
  };
  return path.join(getXCollectorDir(), "scripts", map[name]);
}

function spawnXProcess(name: "worker" | "scheduler" | "dashboard"): ProcessRecord {
  const existing = managedProcesses.get(name);
  if (existing) {
    return existing;
  }

  const script = resolveScript(name);
  if (!fs.existsSync(script)) {
    throw new Error(`Скрипт ${script} не найден`);
  }

  const child = spawn("npx", ["tsx", script], {
    cwd: getXCollectorDir(),
    env: { ...process.env },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  const record: ProcessRecord = {
    pid: child.pid ?? 0,
    startedAt: Date.now(),
    command: `npx tsx ${script}`,
  };
  managedProcesses.set(name, record);

  child.on("exit", () => {
    if (managedProcesses.get(name)?.pid === record.pid) {
      managedProcesses.delete(name);
    }
  });
  child.unref();

  return record;
}

function stopXProcess(name: "worker" | "scheduler" | "dashboard") {
  const record = managedProcesses.get(name);
  if (!record) return false;
  try {
    process.kill(record.pid, "SIGTERM");
  } catch {
    // idempotent — already gone
  }
  managedProcesses.delete(name);
  return true;
}

async function probeHttp(url: string, timeoutMs = 2500): Promise<{ reachable: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    return { reachable: response.ok, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { reachable: false, detail: error instanceof Error ? error.message : "недоступен" };
  } finally {
    clearTimeout(timer);
  }
}

export async function getXCollectorSummary(): Promise<XCollectorSummary> {
  const dir = getXCollectorDir();
  const dirExists = fs.existsSync(dir);
  const nodeModulesPresent = fs.existsSync(path.join(dir, "node_modules"));

  const migrationsPath = path.join(dir, "migrations");
  const missing = dirExists
    ? REQUIRED_MIGRATIONS.filter((name) => !fs.existsSync(path.join(migrationsPath, name)))
    : [...REQUIRED_MIGRATIONS];

  // Parse x-collector .env to get config status
  const envPath = path.join(dir, ".env");
  const envConfig = parseEnvFile(envPath);
  const databaseUrlFromEnv = envConfig.DATABASE_URL;
  const masterKeyFromEnv = envConfig.MASTER_KEY;
  const databaseUrlConfigured = Boolean(databaseUrlFromEnv);
  const masterKeyConfigured = Boolean(masterKeyFromEnv);
  const databaseUrlForProbe = databaseUrlFromEnv || process.env.X_COLLECTOR_DATABASE_URL || process.env.DATABASE_URL;

  const workerHost = process.env.X_COLLECTOR_METRICS_HOST || "127.0.0.1";
  const workerPort = Number(process.env.X_COLLECTOR_METRICS_PORT || process.env.METRICS_PORT || 9091);
  const dashboardHost = "127.0.0.1";
  const dashboardPort = Number(process.env.X_COLLECTOR_DASHBOARD_PORT || process.env.DASHBOARD_PORT || 3001);

  const [workerHealth, dashboardHealth, dbHealth] = await Promise.all([
    probeHttp(`http://${workerHost}:${workerPort}/health`),
    probeHttp(`http://${dashboardHost}:${dashboardPort}/api/health`),
    probeDb(databaseUrlForProbe),
  ]);

  return {
    installed: dirExists && nodeModulesPresent,
    dirExists,
    nodeModulesPresent,
    env: {
      databaseUrlConfigured,
      masterKeyConfigured,
    },
    migrations: {
      complete: missing.length === 0,
      missing,
      path: migrationsPath,
    },
    processes: {
      worker: managedProcesses.get("worker") ?? null,
      scheduler: managedProcesses.get("scheduler") ?? null,
      dashboard: managedProcesses.get("dashboard") ?? null,
    },
    health: {
      worker: { url: `http://${workerHost}:${workerPort}/health`, ...workerHealth },
      dashboard: { url: `http://${dashboardHost}:${dashboardPort}/api/health`, ...dashboardHealth },
    },
    db: dbHealth,
  };
}

export async function runXCollectorAction(action: XCollectorAction) {
  switch (action) {
    case "worker-start":
      return { ok: true, process: spawnXProcess("worker") };
    case "worker-stop":
      return { ok: true, stopped: stopXProcess("worker") };
    case "scheduler-start":
      return { ok: true, process: spawnXProcess("scheduler") };
    case "scheduler-stop":
      return { ok: true, stopped: stopXProcess("scheduler") };
    case "dashboard-start":
      return { ok: true, process: spawnXProcess("dashboard") };
    case "dashboard-stop":
      return { ok: true, stopped: stopXProcess("dashboard") };
    case "migrate-status":
    case "migrate":
    case "login":
      return runOneShot(action);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function runOneShot(action: "migrate" | "migrate-status" | "login"): Promise<{ ok: boolean; output: string }> {
  const script = action === "login" ? "x-login.ts" : "migrate.ts";
  const args = action === "migrate-status" ? ["--status"] : [];
  const scriptPath = path.join(getXCollectorDir(), "scripts", script);

  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", scriptPath, ...args], {
      cwd: getXCollectorDir(),
      env: { ...process.env },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        output: `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim(),
      });
    });

    child.on("error", (error) => {
      resolve({ ok: false, output: error.message });
    });

    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill();
        resolve({ ok: false, output: "Команда превысила таймаут (60с) и была остановлена." });
      }
    }, 60_000);
  });
}
