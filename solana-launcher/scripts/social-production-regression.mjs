import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const launcherRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(launcherRoot, "..");

const launcherCompose = readFileSync(join(launcherRoot, "docker-compose.production.yml"), "utf8");
const intelligenceCompose = readFileSync(join(repoRoot, "memecoin-intelligence", "docker-compose.production.yml"), "utf8");
const socialAiRoute = readFileSync(join(launcherRoot, "app", "api", "trade", "social-ai", "route.ts"), "utf8");
const xLogin = readFileSync(join(launcherRoot, "scripts", "x-login.mjs"), "utf8");
const telegramLogin = readFileSync(join(launcherRoot, "backend", "app", "cli", "telegram_login.py"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(`[social-production-regression] ${message}`);
}

assert(
  launcherCompose.includes("MEMECOIN_INTELLIGENCE_URL: ${MEMECOIN_INTELLIGENCE_URL:-http://memecoin-intelligence-api:3001}"),
  "frontend must use the private memecoin-intelligence Docker DNS endpoint by default",
);
assert(
  launcherCompose.includes("MEMECOIN_INTELLIGENCE_API_KEY: ${MEMECOIN_INTELLIGENCE_API_KEY:-}"),
  "frontend must receive only the scoped memecoin-intelligence API credential",
);
assert(
  /frontend:[\s\S]*?networks:[\s\S]*?- default[\s\S]*?- potapoff-shared/.test(launcherCompose),
  "frontend must join potapoff-shared for private intelligence traffic",
);
assert(
  intelligenceCompose.includes("INTERNAL_USER_API_KEY: ${MEMECOIN_INTELLIGENCE_API_KEY:?set MEMECOIN_INTELLIGENCE_API_KEY}"),
  "memecoin-intelligence must map the shared credential to the non-admin user role",
);
assert(
  intelligenceCompose.includes("- memecoin-intelligence-api"),
  "memecoin-intelligence must publish a stable private Docker network alias",
);
assert(
  intelligenceCompose.includes("TELEGRAM_AI_MODE: ${TELEGRAM_AI_MODE:-openai-compatible}"),
  "production intelligence must default to real OpenAI-compatible/Qwen mode, not mock",
);
assert(
  !intelligenceCompose.includes("TELEGRAM_AI_MODE: ${TELEGRAM_AI_MODE:-mock}"),
  "production compose must never silently default to deterministic mock inference",
);
assert(
  /qwen:[\s\S]*?profiles: \["ai"\][\s\S]*?gpus: all/.test(intelligenceCompose),
  "production compose must retain an opt-in GPU Qwen inference service",
);
assert(
  intelligenceCompose.includes("QWEN_MAX_OUTPUT_TOKENS: ${QWEN_MAX_OUTPUT_TOKENS:-3200}"),
  "production Qwen must preserve the full-intelligence output budget",
);
assert(
  socialAiRoute.includes('"x-api-key": API_KEY'),
  "social-ai bridge must authenticate to memecoin-intelligence with x-api-key",
);
assert(
  socialAiRoute.includes("MEMECOIN_INTELLIGENCE_API_KEY"),
  "social-ai bridge must consume the dedicated intelligence API key",
);
assert(
  xLogin.includes('cookie.name === "auth_token"') && xLogin.includes("await context.storageState({ path: authPath })"),
  "X login must verify an authenticated cookie before persisting browser state",
);
assert(
  telegramLogin.includes("_resolve_api_credentials")
    && !telegramLogin.includes("get_settings()")
    && telegramLogin.includes("TG_SESSION_STRING"),
  "Telegram login must remain independent from unrelated application Settings and persist its MTProto session directly",
);

console.log("[social-production-regression] OK: private Qwen transport, scoped RBAC key, real-inference default and auth guards are wired");
