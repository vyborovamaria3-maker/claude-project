import { q, q1, exec, tx } from "./pg";
import { log } from "./logger";
import { getConfig } from "./config";

export type AccountTier = "new" | "warm" | "hot" | "retired";
export type AccountStatus = "active" | "cooldown" | "captcha" | "banned";
export type RequestKind = "search" | "profile" | "timeline";

export const WEIGHTS: Record<RequestKind, number> = { profile: 1, search: 3, timeline: 5 };

export const TIER_QUOTA: Record<AccountTier, number> = {
  new: 15, warm: 60, hot: 120, retired: 0,
};

const TIER_DELAY_MS: Record<AccountTier, [number, number]> = {
  new: [8000, 20000], warm: [4000, 10000], hot: [2500, 7000], retired: [0, 0],
};

export interface XAccount {
  name: string;
  tier: AccountTier;
  status: AccountStatus;
  session_encrypted: Buffer;
  proxy_json: string | null;
  user_agent: string | null;
  timezone: string | null;
  weight_used_this_hour: number;
  weight_quota_per_hour: number;
  account_busy_until: string;
  account_claimed_by: string;
}

export async function pickAccount(kind: RequestKind, leaseOwner: string): Promise<XAccount | null> {
  if (!leaseOwner || leaseOwner.length > 200) throw new Error("Invalid account lease owner");
  const weight = WEIGHTS[kind];
  const now = Date.now();
  const hourAgo = now - 3600_000;
  const leaseMs = getConfig().sessions.leaseMs;

  return tx(async (c) => {
    await c.query(
      `UPDATE x_accounts SET weight_used_this_hour = 0, hour_window_start = $1
       WHERE hour_window_start < $2`,
      [now, hourAgo]
    );
    await c.query(
      `UPDATE x_accounts
       SET status='active', cooldown_until=0, consecutive_errors=0, updated_at=$1
       WHERE status IN ('cooldown','captcha') AND cooldown_until < $1`,
      [now]
    );
    const r = await c.query<XAccount>(
      `WITH picked AS (
         SELECT name FROM x_accounts
         WHERE status='active' AND tier != 'retired'
           AND COALESCE(account_busy_until, 0) <= $2
           AND weight_used_this_hour + $1 <= weight_quota_per_hour
         ORDER BY CASE tier WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 WHEN 'new' THEN 2 ELSE 3 END,
                  weight_used_this_hour ASC,
                  COALESCE(last_success_at, 0) ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE x_accounts SET
         weight_used_this_hour = x_accounts.weight_used_this_hour + $1,
         total_requests = x_accounts.total_requests + 1,
         account_busy_until = $3,
         account_claimed_by = $4,
         updated_at = $2
       FROM picked
       WHERE x_accounts.name = picked.name
       RETURNING x_accounts.name, x_accounts.tier, x_accounts.status,
                 x_accounts.session_encrypted, x_accounts.proxy_json,
                 x_accounts.user_agent, x_accounts.timezone,
                 x_accounts.weight_used_this_hour, x_accounts.weight_quota_per_hour,
                 x_accounts.account_busy_until, x_accounts.account_claimed_by`,
      [weight, now, now + leaseMs, leaseOwner]
    );
    return r.rows[0] ?? null;
  });
}

export async function extendAccountLease(name: string, leaseOwner: string, leaseMs: number): Promise<boolean> {
  const now = Date.now();
  const changed = await exec(
    `UPDATE x_accounts SET account_busy_until=$1, updated_at=$2
     WHERE name=$3 AND account_claimed_by=$4`,
    [now + leaseMs, now, name, leaseOwner]
  );
  return changed > 0;
}

export async function releaseAccount(name: string, leaseOwner: string, cooldownMs = 0): Promise<boolean> {
  const now = Date.now();
  const changed = await exec(
    `UPDATE x_accounts
     SET account_busy_until=$1, account_claimed_by=NULL, updated_at=$2
     WHERE name=$3 AND account_claimed_by=$4`,
    [now + Math.max(0, Math.ceil(cooldownMs)), now, name, leaseOwner]
  );
  return changed > 0;
}

export async function recordSuccess(name: string) {
  await exec(
    `UPDATE x_accounts SET consecutive_errors=0, last_success_at=$1, updated_at=$1 WHERE name=$2`,
    [Date.now(), name]
  );
}

export async function recordError(name: string, kind: "rate_limit" | "captcha" | "ban" | "other") {
  const cfg = getConfig();
  const now = Date.now();
  const cooldownMs = {
    rate_limit: cfg.sessions.cooldownAfterRateLimitMs,
    captcha: cfg.sessions.cooldownAfterCaptchaMs,
    ban: 0,
    other: 0,
  }[kind];

  await exec(
    `UPDATE x_accounts
     SET consecutive_errors = consecutive_errors + 1,
         total_errors = total_errors + 1,
         last_error_at = $1,
         status = CASE
           WHEN $2 = 'ban' THEN 'banned'
           WHEN $2 = 'captcha' THEN 'captcha'
           WHEN $2 = 'rate_limit' THEN 'cooldown'
           ELSE status
         END,
         cooldown_until = CASE WHEN $3 > 0 THEN $1::bigint + $3::bigint ELSE cooldown_until END,
         updated_at = $1
     WHERE name = $4`,
    [now, kind, cooldownMs, name]
  );

  const row = await q1<{ ce: number }>(
    `SELECT consecutive_errors AS ce FROM x_accounts WHERE name=$1`, [name]
  );
  const shouldBan = row && row.ce >= cfg.sessions.banAfterConsecutiveErrors
    && (kind === "ban" || kind === "captcha" || kind === "rate_limit");
  if (shouldBan) {
    await exec(`UPDATE x_accounts SET status='banned', updated_at=$1 WHERE name=$2`, [now, name]);
    log.error("account banned after consecutive errors", { name, errors: row!.ce, kind });
  }
}

export function getAccountDelay(tier: AccountTier): number {
  const [min, max] = TIER_DELAY_MS[tier];
  return min + Math.random() * (max - min);
}

export async function registerAccount(
  name: string, sessionEncrypted: Buffer, tier: AccountTier = "new", proxyJson?: string
) {
  const now = Date.now();
  const quota = TIER_QUOTA[tier];
  await exec(
    `INSERT INTO x_accounts
       (name, session_encrypted, tier, status, weight_quota_per_hour,
        hour_window_start, created_at, updated_at, proxy_json)
     VALUES ($1,$2,$3,'active',$4,$5,$5,$5,$6)
     ON CONFLICT(name) DO UPDATE SET
       session_encrypted = EXCLUDED.session_encrypted,
       updated_at = EXCLUDED.updated_at,
       proxy_json = COALESCE(EXCLUDED.proxy_json, x_accounts.proxy_json)`,
    [name, sessionEncrypted, tier, quota, now, proxyJson ?? null]
  );
}

export async function promoteTier(name: string, tier: AccountTier) {
  await exec(
    `UPDATE x_accounts SET tier=$1, weight_quota_per_hour=$2, updated_at=$3 WHERE name=$4`,
    [tier, TIER_QUOTA[tier], Date.now(), name]
  );
}

export interface AccountRow {
  name: string; tier: string; status: string; quota: string;
  total_requests: string; total_errors: string;
  consecutive_errors: number; cooldown_sec: string;
}

export async function listAccounts(): Promise<AccountRow[]> {
  return q<AccountRow>(
    `SELECT name, tier, status,
            weight_used_this_hour || '/' || weight_quota_per_hour AS quota,
            total_requests, total_errors, consecutive_errors,
            GREATEST(0, cooldown_until - $1) / 1000 AS cooldown_sec
     FROM x_accounts ORDER BY tier, status, weight_used_this_hour DESC`,
    [Date.now()]
  );
}

