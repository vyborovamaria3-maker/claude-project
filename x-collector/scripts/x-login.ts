import { chromium } from "playwright";
import readline from "node:readline";
import { encryptBuffer } from "../lib/trade/crypto";
import { registerAccount, type AccountRole } from "../lib/trade/account-manager";
import { closePool } from "../lib/trade/pg";

const accountName = process.argv[2];
const requestedRole = process.argv[3] ?? "collector";
if (requestedRole !== "collector" && requestedRole !== "publisher") throw new Error("Role must be collector or publisher");
const role: AccountRole = requestedRole;
if (!accountName) {
  console.error("Usage: npx ts-node scripts/x-login.ts <account-name> [collector|publisher]");
  process.exit(1);
}
if (!/^[a-zA-Z0-9_-]{1,40}$/.test(accountName)) {
  console.error("Account name должен быть [a-zA-Z0-9_-]{1,40}");
  process.exit(1);
}
if (!process.env.DATABASE_URL || !process.env.MASTER_KEY) {
  console.error("Нужны DATABASE_URL и MASTER_KEY в env");
  process.exit(1);
}

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

async function main() {
  console.log(`[x-login] аккаунт: ${accountName}`);
  console.log("[x-login] запускаю браузер...");

  let encryptedSession: Buffer | null;
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  try {
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto("https://x.com/login", { waitUntil: "domcontentloaded" });

    console.log("");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  Залогинься в открывшемся окне.");
    console.log("  Дождись главной ленты x.com.");
    console.log("  Потом вернись сюда и нажми Enter.");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    await waitForEnter("\nНажми Enter, когда залогинишься... ");

    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    if (currentUrl.includes("/login") || currentUrl.includes("/i/flow/login")) {
      throw new Error("логин не удался — всё ещё на странице логина");
    }

    // Keep the session state in memory: never create a plaintext cookie file on disk.
    const state = await context.storageState();
    const serializedState = Buffer.from(JSON.stringify(state), "utf8");
    try { encryptedSession = encryptBuffer(serializedState); }
    finally { serializedState.fill(0); }
    console.log("[x-login] сессия получена и зашифрована в памяти");
  } finally {
    await browser.close().catch(() => {});
  }

  try {
    if (!encryptedSession) throw new Error("encrypted session was not captured");
    await registerAccount(accountName, encryptedSession, "new", undefined, role);
    console.log(`[x-login] ✓ аккаунт "${accountName}" зарегистрирован в БД`);
  } finally {
    await closePool().catch(() => {});
  }
}

main().catch(async (e) => {
  console.error("[x-login] ошибка:", e instanceof Error ? e.message : e);
  await closePool().catch(() => {});
  process.exit(1);
});
