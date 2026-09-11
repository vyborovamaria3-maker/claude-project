import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const repoRoot = path.dirname(root);
const args = process.argv.slice(2);
const mint = args.find((value) => !value.startsWith("--")) || "";

function cliValue(name) {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

const frontend = cliValue("frontend") || process.env.SOCIAL_FRONTEND_URL || "http://localhost:3002";
const backend = cliValue("backend") || process.env.BACKEND_URL || "http://localhost:8000";
const intelligence = cliValue("intelligence") || process.env.MEMECOIN_INTELLIGENCE_URL || "http://localhost:3001";

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const rows = {};
  for (const rawLine of fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    rows[key] = value;
  }
  return rows;
}

function yes(value) {
  return Boolean(String(value || "").trim());
}

function bool(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function validTelegramApiId(value) {
  return /^\d+$/.test(String(value || "").trim());
}

function validTelegramApiHash(value) {
  return /^[0-9a-f]{32}$/i.test(String(value || "").trim());
}

async function checkJson(label, url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), cache: "no-store" });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    console.log(`${response.ok ? "OK" : "WARN"}  ${label}: HTTP ${response.status}`);
    return { ok: response.ok, status: response.status, data, text };
  } catch (error) {
    console.log(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, status: 0, data: null, text: "" };
  }
}

console.log("POTAPoff Social Intelligence local preflight");
console.log(`frontend=${frontend}`);
console.log(`backend=${backend}`);
console.log(`intelligence=${intelligence}`);
if (!cliValue("frontend") && !process.env.SOCIAL_FRONTEND_URL) {
  console.log("note: frontend uses default 3002; for another worktree pass --frontend=http://localhost:<port>");
}
console.log("");

const backendEnv = parseEnvFile(path.join(root, "backend", ".env"));
const intelligenceEnv = parseEnvFile(path.join(repoRoot, "memecoin-intelligence", ".env"));
const xAuthPath = path.join(root, "data", "x-auth", "storage-state.json");
const frontendEnv = {
  ...parseEnvFile(path.join(root, ".env")),
  ...parseEnvFile(path.join(root, ".env.local")),
  ...parseEnvFile(path.join(root, ".env.development.local")),
};

const tgApiIdValid = validTelegramApiId(backendEnv.TG_API_ID);
const tgApiHashValid = validTelegramApiHash(backendEnv.TG_API_HASH);
const tgSessionReady = yes(backendEnv.TG_SESSION_STRING);
const telegramAuthReady = tgApiIdValid && tgApiHashValid && tgSessionReady;
const telegramAutoMonitorReady = telegramAuthReady
  && yes(backendEnv.TG_MONITOR_CHANNELS)
  && bool(backendEnv.TG_AUTOSTART);
const telegramPublicWebReady = bool(backendEnv.TG_PUBLIC_WEB_ENABLED)
  && (yes(backendEnv.TG_PUBLIC_WEB_CHANNELS) || yes(backendEnv.TG_PUBLIC_WEB_SEED_DATABASE));
const backendSecretReady = String(backendEnv.SECRET_KEY || "").trim().length >= 32;

console.log("Local configuration (values are never printed):");
console.log(`  SECRET_KEY_VALID=${backendSecretReady}`);
console.log(`  ENVIRONMENT=${backendEnv.ENVIRONMENT || "default"}`);
console.log(`  TG_API_ID_VALID=${tgApiIdValid}`);
console.log(`  TG_API_HASH_VALID=${tgApiHashValid}`);
console.log(`  TG_SESSION_STRING=${tgSessionReady}`);
console.log(`  TG_AUTH_READY=${telegramAuthReady}`);
console.log(`  TG_MONITOR_CHANNELS=${yes(backendEnv.TG_MONITOR_CHANNELS)}`);
console.log(`  TG_AUTOSTART=${bool(backendEnv.TG_AUTOSTART)}`);
console.log(`  TG_AUTO_MONITOR_READY=${telegramAutoMonitorReady}`);
console.log(`  TG_PUBLIC_WEB_ENABLED=${bool(backendEnv.TG_PUBLIC_WEB_ENABLED)}`);
console.log(`  TG_PUBLIC_WEB_READY=${telegramPublicWebReady}`);
console.log(`  X_BROWSER_SESSION=${fs.existsSync(xAuthPath)}`);
console.log(`  HELIUS_KEYS=${yes(frontendEnv.HELIUS_API_KEYS) || yes(frontendEnv.HELIUS_API_KEY)}`);
console.log(`  MEMECOIN_INTELLIGENCE_URL=${yes(frontendEnv.MEMECOIN_INTELLIGENCE_URL)}`);
console.log(`  TELEGRAM_AI_ENABLED=${bool(intelligenceEnv.TELEGRAM_AI_ENABLED)}`);
console.log(`  TELEGRAM_AI_MODE=${intelligenceEnv.TELEGRAM_AI_MODE || "default"}`);
console.log(`  QWEN_LOAD_MODE=${intelligenceEnv.QWEN_LOAD_MODE || "default"}`);
console.log(`  QWEN_MAX_OUTPUT_TOKENS=${intelligenceEnv.QWEN_MAX_OUTPUT_TOKENS || "default"}`);
console.log("");

if (!backendSecretReady) {
  console.log("WARN  backend SECRET_KEY is missing/too short; FastAPI Settings can fail before Telegram login starts");
}
if (yes(backendEnv.TG_API_ID) && !tgApiIdValid) {
  console.log("WARN  TG_API_ID is present but is not a plain integer; check for accidentally concatenated .env lines");
}
if (yes(backendEnv.TG_API_HASH) && !tgApiHashValid) {
  console.log("WARN  TG_API_HASH is present but does not look like a 32-character Telegram API hash");
}
if (tgApiIdValid && tgApiHashValid && !tgSessionReady) {
  console.log("INFO  Telegram API credentials are configured; run `python -m app.cli.telegram_login --write-env` to create the user session");
}
if (telegramAuthReady && !telegramAutoMonitorReady) {
  console.log("INFO  Telegram user auth is ready. Auto-monitor is optional; TG_MONITOR_CHANNELS is not required for login/auth.");
}

const frontendHealth = await checkJson("Next frontend", `${frontend}/api/i18n/status`);
const backendHealth = await checkJson("FastAPI", `${backend}/health`);
const intelligenceHealth = await checkJson("Memecoin Intelligence", `${intelligence}/api/health`);
const qwen = await checkJson("Qwen status", `${intelligence}/api/telegram-ai/status`);

let directQwen = null;
if (qwen.data) {
  const inference = qwen.data.inference || {};
  console.log(`  Qwen enabled=${Boolean(qwen.data.enabled)} mode=${inference.mode || "unknown"} reachable=${String(inference.reachable)} model=${inference.model || "unknown"}`);
  if (inference.mode === "openai-compatible") {
    const configuredBase = String(intelligenceEnv.TELEGRAM_AI_BASE_URL || "http://localhost:8002/v1");
    const healthBase = configuredBase.replace(/\/v1\/?$/, "");
    directQwen = await checkJson("Qwen inference service", `${healthBase}/health`);
    if (directQwen.data) {
      console.log(`  Qwen loaded=${String(directQwen.data.loaded)} cuda=${String(directQwen.data.cudaAvailable)} loadMode=${directQwen.data.loadMode || "unknown"}`);
      if (directQwen.data.error) console.log(`  Qwen error=${directQwen.data.error}`);
    }
  }
}

if (mint) {
  console.log("");
  const x = await checkJson("X collector", `${frontend}/api/trade/dev-twitter?mint=${encodeURIComponent(mint)}&strategy=auto&scope=mentions&limit=10&excludeSuspicious=true&verifiedOnly=false`);
  if (x.data?.collectionStrategy) {
    console.log(`  X strategy=${x.data.collectionStrategy} posts=${x.data.totalTweets ?? "?"} browserAuth=${x.data.meta?.authenticatedBrowser ?? "?"} coverage=${x.data.meta?.coverageConfirmed ?? "?"}`);
  } else if (x.data?.error || x.data?.detail) {
    console.log(`  X detail=${x.data.error || x.data.detail}`);
  }
}

console.log("");
const inference = qwen.data?.inference || {};
const directQwenCompatible = inference.mode !== "openai-compatible"
  || Boolean(
    directQwen?.ok
    && !(directQwen.data?.loadMode === "4bit" && directQwen.data?.cudaAvailable === false)
    && !directQwen.data?.error,
  );
const qwenReady = Boolean(
  qwen.ok
  && qwen.data?.enabled
  && inference.reachable === true
  && directQwenCompatible,
);
const processReady = frontendHealth.ok && backendHealth.ok && intelligenceHealth.ok;
console.log(
  `SUMMARY processes=${processReady ? "READY" : "CHECK"}`
  + ` telegramAuth=${telegramAuthReady ? "READY" : "CHECK"}`
  + ` telegramAutoMonitor=${telegramAutoMonitorReady ? "READY" : "OFF"}`
  + ` telegramPublicWeb=${telegramPublicWebReady ? "READY" : "OFF"}`
  + ` xAuth=${fs.existsSync(xAuthPath) ? "READY" : "CHECK"}`
  + ` qwen=${qwenReady ? "READY" : "CHECK"}`,
);
console.log("Telegram token data itself is protected by subscriber auth and is verified in the logged-in localhost UI.");
