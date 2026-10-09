import { chromium, Browser } from "playwright";
import readline from "node:readline";
import { encryptBuffer } from "../lib/trade/crypto";
import { registerAccount } from "../lib/trade/account-manager";
import { closePool } from "../lib/trade/pg";

const TAG = "[x-login]";

const accountName = process.argv[2];
if (!accountName) {
  console.error(`${TAG} failed: Usage: npx tsx scripts/x-login.ts <account-name>`);
  process.exit(1);
}
if (!/^[a-zA-Z0-9_-]{1,40}$/.test(accountName)) {
  console.error(`${TAG} failed: account name должен быть [a-zA-Z0-9_-]{1,40}`);
  process.exit(1);
}
if (!process.env.DATABASE_URL || !process.env.MASTER_KEY) {
  console.error(`${TAG} failed: нужны DATABASE_URL и MASTER_KEY в env`);
  process.exit(1);
}

function log(msg: string): void {
  console.log(`${TAG} ${msg}`);
}

function fail(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  const cause = e instanceof Error && e.cause instanceof Error
    ? (e.cause.message || String(e.cause))
    : e instanceof Error && e.cause !== undefined
      ? String(e.cause)
      : "";
  console.error(`${TAG} failed: ${msg}`);
  if (cause && cause !== msg) console.error(`${TAG} cause: ${cause}`);
  process.exit(1);
}

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

async function main() {
  log(`account: ${accountName}`);
  log("starting browser");

  let browser: Browser | null = null;
  let encryptedSession: Buffer | null;
  try {
    browser = await chromium.launch({ headless: false, slowMo: 50 });
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto("https://x.com/login", {
      waitUntil: "commit",
      timeout: 120000
    });

    log("waiting for login");
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
      throw new Error(`логин не удался — всё ещё на странице логина (${currentUrl})`, { cause: new Error("login flow not completed") });
    }

    log("saving session");
    // Keep the session state in memory: never create a plaintext cookie file on disk.
    const state = await context.storageState();
    const serializedState = Buffer.from(JSON.stringify(state), "utf8");
    try { encryptedSession = encryptBuffer(serializedState); }
    finally { serializedState.fill(0); }

    if (!encryptedSession) throw new Error("encrypted session was not captured");
    await registerAccount(accountName, encryptedSession, "new");
    log(`account registered: ${accountName} (tier=new, status=active)`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await closePool().catch(() => {});
  }
}

main().catch(fail);
