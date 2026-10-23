import { Client } from "pg";
import dotenv from 'dotenv';
import {encryptBuffer} from '../lib/trade/crypto';

export async function encryptSession(plain: string): Promise<Buffer> {
  const bytes=Buffer.from(plain,'utf8');
  try{return encryptBuffer(bytes);}finally{bytes.fill(0);}
}

async function main() {
  dotenv.config();
  const handle = process.argv[2];
  const cookies = process.argv[3];
  const proxyJson = process.argv[4] || "{}";
  const user_agent = process.argv[5] || "";
  const timezone = process.argv[6] || "UTC";
  const now = Date.now();

  if (!handle || !cookies) {
    console.error("Usage: npx tsx register.ts <handle> <cookies> [proxyJson] [userAgent] [timezone]");
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }

  const client = new Client({ connectionString: dbUrl });
  try {
    await client.connect();
    const sessionEncrypted = await encryptSession(cookies);
    const proxy = JSON.parse(proxyJson);

    await client.query(`
      INSERT INTO x_accounts (
        name, session_encrypted, proxy_json, user_agent, timezone,
        tier, status, weight_quota_per_hour, weight_used_this_hour,
        hour_window_start, total_requests, consecutive_errors,
        last_success_at, last_error_at, cooldown_until, account_busy_until,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        'new', 'active', 15, 0, $6, 0, 0, 0, 0, 0, 0, $7, $7
      )
    `, [
      handle,
      sessionEncrypted,
      JSON.stringify(proxy),
      user_agent,
      timezone,
      now,
      now,
    ]);
    console.log(`Account ${handle} registered successfully.`);
  } catch {
    console.error("Failed to register account. Check keyring, database and input format.");
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

if(require.main===module)void main();
