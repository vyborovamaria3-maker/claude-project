import fs from "node:fs";
import { encryptBuffer } from "../lib/trade/crypto";
import { registerAccount } from "../lib/trade/account-manager";
import { closePool } from "../lib/trade/pg";

const TAG = "[x-import]";

const [accountName, statePath] = process.argv.slice(2);

function fail(msg: string, cause?: unknown): never {
  console.error(`${TAG} failed: ${msg}`);
  if (cause instanceof Error) console.error(`${TAG} cause: ${cause.message}`);
  process.exit(1);
}

function readFileOrExit(path: string): string {
  try {
    return fs.readFileSync(path, "utf8");
  } catch (e) {
    return fail("cannot read storage state", e);
  }
}

async function main() {
  if (!accountName || !statePath) {
    fail("usage: tsx scripts/import-session.ts <account-name> <storage-state.json>");
  }
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(accountName)) {
    fail("account name должен быть [a-zA-Z0-9_-]{1,40}");
  }
  if (!process.env.DATABASE_URL || !process.env.MASTER_KEY) {
    fail("нужны DATABASE_URL и MASTER_KEY в env");
  }
  if (!fs.existsSync(statePath)) fail(`file not found: ${statePath}`);

  console.log(`${TAG} reading ${statePath}`);
  const raw = readFileOrExit(statePath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fail("storage state is not valid JSON", e);
  }
  const cookies = Array.isArray(parsed) ? parsed : (parsed as { cookies?: unknown })?.cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) fail("storage state has no cookies");
  const xCookies = (cookies as Array<{ domain?: string }>)
    .filter((c) => (c.domain ?? "").includes("x.com") || (c.domain ?? "").includes("twitter.com"));
  if (xCookies.length === 0) fail("storage state has no x.com/twitter.com cookies");

  console.log(`${TAG} cookies: ${cookies.length} (x.com=${xCookies.length})`);
  console.log(`${TAG} encrypting session in memory`);

  const plain = Buffer.from(raw, "utf8");
  let encrypted: Buffer;
  try {
    encrypted = encryptBuffer(plain);
  } finally {
    plain.fill(0);
  }

  try {
    await registerAccount(accountName, encrypted, "new");
  } catch (e) {
    fail("registerAccount failed", e);
  }

  console.log(`${TAG} account registered: ${accountName} (tier=new, status=active)`);
}

main()
  .catch((e) => fail(e instanceof Error ? e.message : String(e), e))
  .finally(() => closePool().catch(() => {}));
