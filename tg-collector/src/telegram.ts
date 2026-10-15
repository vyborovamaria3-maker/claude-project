import "dotenv/config";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

function credentials(): { apiId: number; apiHash: string } {
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH;
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash) {
    throw new Error("Set TG_API_ID and TG_API_HASH in .env");
  }
  return { apiId, apiHash };
}

export function sessionPath(): string {
  return resolve(process.env.TG_SESSION_FILE || ".tg-session");
}

export async function login(): Promise<void> {
  const { apiId, apiHash } = credentials();
  const rl = createInterface({ input: stdin, output: stdout });
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 3,
    floodSleepThreshold: 0,
  });
  try {
    await client.start({
      phoneNumber: async () => rl.question("Telegram phone (+...): "),
      phoneCode: async () => rl.question("Login code: "),
      password: async () => rl.question("2FA password (if requested): "),
      onError: (error: Error) => console.error("Login error:", error.message),
    });
    if (!(await client.isUserAuthorized())) throw new Error("Telegram authorization failed");
    const path = sessionPath();
    await writeFile(path, client.session.save(), { mode: 0o600 });
    await chmod(path, 0o600);
    console.log("Session saved locally. Keep .tg-session private and out of Git.");
  } finally {
    rl.close();
    await client.disconnect();
  }
}

export async function authorizedClient(): Promise<TelegramClient> {
  const { apiId, apiHash } = credentials();
  const sessionString = (await readFile(sessionPath(), "utf8")).trim();
  if (!sessionString) throw new Error("Session file is empty; run npm run login");
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 3,
    retryDelay: 1000,
    floodSleepThreshold: 0,
    autoReconnect: true,
  });
  await client.connect();
  if (!(await client.isUserAuthorized())) {
    await client.disconnect();
    throw new Error("Telegram session expired; run npm run login");
  }
  return client;
}
