import fs from "fs";
import path from "path";
import readline from "readline/promises";
import { chromium } from "playwright";

const root = process.cwd();
const authDir = path.join(root, "data", "x-auth");
const authPath = path.join(authDir, "storage-state.json");

fs.mkdirSync(authDir, { recursive: true });

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
  // Hide automation
  extraHTTPHeaders: {
    "Accept-Language": "en-US,en;q=0.9",
  },
});
const page = await context.newPage();

console.log("Opening X/Twitter login page...");
console.log("Log in manually. Do not share password/codes in chat.");
await page.goto("https://x.com/login", { waitUntil: "domcontentloaded", timeout: 60000 });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question("After successful login, press Enter here to save session... ");
rl.close();

await context.storageState({ path: authPath });
await browser.close();

console.log(`Saved X auth session to: ${authPath}`);
console.log("Keep this file private. It contains active session cookies.");
