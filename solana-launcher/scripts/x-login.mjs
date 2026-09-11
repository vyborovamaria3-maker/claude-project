import fs from "fs";
import path from "path";
import readline from "readline/promises";
import { chromium } from "playwright";

const root = process.cwd();
const authDir = path.join(root, "data", "x-auth");
const authPath = path.join(authDir, "storage-state.json");
const LOGIN_PATHS = ["/login", "/i/flow/login"];

fs.mkdirSync(authDir, { recursive: true });

function isLoginUrl(value) {
  try {
    const url = new URL(value);
    return LOGIN_PATHS.some((pathName) => url.pathname.startsWith(pathName));
  } catch {
    return true;
  }
}

async function hasAuthenticatedCookie(context) {
  const cookies = await context.cookies(["https://x.com", "https://twitter.com"]);
  return cookies.some((cookie) => cookie.name === "auth_token" && Boolean(cookie.value));
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 50,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    locale: "en-US",
    timezoneId: "America/New_York",
    permissions: ["geolocation"],
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  const page = await context.newPage();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("Opening X/Twitter login page...");
    console.log("Log in manually. Do not share password/codes in chat.");
    await page.goto("https://x.com/login", { waitUntil: "domcontentloaded", timeout: 60000 });

    await rl.question("After successful login and after X home/feed opens, press Enter here... ");

    const cookieReady = await hasAuthenticatedCookie(context);
    if (!cookieReady) {
      throw new Error(
        "X authentication was not confirmed: auth_token cookie is missing. Finish login in the opened browser and run `npm run x:login` again.",
      );
    }

    if (isLoginUrl(page.url())) {
      await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1500);
    }

    if (isLoginUrl(page.url())) {
      throw new Error(
        "X redirected back to the login flow. The session was not saved; complete login and try again.",
      );
    }

    if (!(await hasAuthenticatedCookie(context))) {
      throw new Error("X auth cookie disappeared during validation. The session was not saved.");
    }

    await context.storageState({ path: authPath });
    console.log(`Saved verified X auth session to: ${authPath}`);
    console.log("Keep this file private. It contains active session cookies.");
  } finally {
    rl.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`X login failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
