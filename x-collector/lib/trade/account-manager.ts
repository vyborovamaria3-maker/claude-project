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
  language?: string | null;
  weight_used_this_hour: number;
  weight_quota_per_hour: number;
  account_busy_until: string;
  account_claimed_by: string;
}

export async function pickAccount(kind: RequestKind, leaseOwner: string, preferredAccount?: string, allowFallback = false, requireProxy = false): Promise<XAccount | null> {
  if (!leaseOwner || leaseOwner.length > 200) throw new Error("Invalid account lease owner");
  const weight = WEIGHTS[kind];
  const now = Date.now();
  const hourAgo = now - 3600_000;
  const leaseMs = getConfig().sessions.leaseMs;

  return tx(async (c) => {
    const available = await c.query("SELECT to_regclass('xc_discovery_plan') AS present");
    if (available.rows[0]?.present) {
      await c.query('SELECT pg_advisory_xact_lock(742098535)');
      const policy = (await c.query('SELECT max_browser_accounts FROM xc_discovery_plan WHERE enabled')).rows[0];
      if (policy && Number((await c.query("SELECT count(*) AS count FROM x_accounts WHERE role='collector' AND account_busy_until>$1", [now])).rows[0].count) >= policy.max_browser_accounts) return null;
    }
    await c.query(
      `UPDATE x_accounts SET weight_used_this_hour = 0, hour_window_start = $1
       WHERE hour_window_start < $2`,
      [now, hourAgo]
    );
    await c.query(
      `UPDATE x_accounts
       SET status='active', cooldown_until=0, consecutive_errors=0, updated_at=$1
       WHERE status='cooldown' AND cooldown_until < $1`,
      [now]
    );
    const r = await c.query<XAccount>(
      `WITH picked AS (
         SELECT name FROM x_accounts
         WHERE role='collector' AND status='active' AND tier != 'retired'
           AND ($5::text IS NULL OR name=$5 OR $6)
           AND (NOT $7::boolean OR proxy_json IS NOT NULL)
           AND COALESCE(account_busy_until, 0) <= $2
           AND weight_used_this_hour + $1 <= weight_quota_per_hour
         ORDER BY CASE WHEN name=$5 THEN 0 ELSE 1 END,
                  CASE tier WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 WHEN 'new' THEN 2 ELSE 3 END,
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
                 x_accounts.user_agent, x_accounts.timezone, x_accounts.language,
                 x_accounts.weight_used_this_hour, x_accounts.weight_quota_per_hour,
                 x_accounts.account_busy_until, x_accounts.account_claimed_by`,
      [weight, now, now + leaseMs, leaseOwner, preferredAccount ?? null, allowFallback, requireProxy]
    );
    return r.rows[0] ?? null;
  });
}

export async function accountWaitMs(kind: RequestKind, preferredAccount?: string, allowFallback = false, requireProxy = false): Promise<number> {
  const now = Date.now();
  const row = await q1<{ready_at:string|null}>(
    `SELECT min(greatest($1::bigint,COALESCE(account_busy_until,0),COALESCE(cooldown_until,0),
      CASE WHEN weight_used_this_hour+$2>weight_quota_per_hour THEN hour_window_start+3600000 ELSE $1::bigint END))::text ready_at
     FROM x_accounts WHERE role='collector' AND status IN ('active','cooldown') AND tier!='retired'
       AND weight_quota_per_hour >= $2 AND ($3::text IS NULL OR name=$3 OR $4)
       AND (NOT $5::boolean OR proxy_json IS NOT NULL)`,
    [now,WEIGHTS[kind],preferredAccount??null,allowFallback,requireProxy]);
  return row?.ready_at ? Math.max(5000, Math.min(3600000,Number(row.ready_at)-now+1000)) : 60000;
}

export async function extendAccountLease(name: string, leaseOwner: string, leaseMs: number): Promise<boolean> {
  const now = Date.now();
  const changed = await exec(
    `UPDATE x_accounts SET account_busy_until=$1, updated_at=$2
     WHERE name=$3 AND account_claimed_by=$4 AND account_busy_until > $2`,
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

export async function recordSuccess(name: string, leaseOwner?: string) {
  await exec(
    `UPDATE x_accounts SET consecutive_errors=0, last_success_at=$1, updated_at=$1 WHERE name=$2
      AND ($3::text IS NULL OR (account_claimed_by=$3 AND account_busy_until>$1))`,
    [Date.now(), name, leaseOwner ?? null]
  );
}

export async function recordError(name: string, kind: "rate_limit" | "captcha" | "ban" | "auth_expired" | "other", serverDelayMs = 0, leaseOwner?: string) {
  const cfg = getConfig();
  const now = Date.now();
  const cooldownMs = {
    rate_limit: Math.max(cfg.sessions.cooldownAfterRateLimitMs, serverDelayMs),
    captcha: cfg.sessions.cooldownAfterCaptchaMs,
    ban: 0,
    auth_expired: 0,
    other: 0,
  }[kind];

  await exec(
    `UPDATE x_accounts
     SET consecutive_errors = consecutive_errors + 1,
         total_errors = total_errors + 1,
         last_error_at = $1,
         status = CASE
           WHEN $2 = 'ban' THEN 'banned'
           WHEN $2 IN ('captcha', 'auth_expired') THEN 'captcha'
           WHEN $2 = 'rate_limit' THEN 'cooldown'
           ELSE status
         END,
         cooldown_until = CASE WHEN $3 > 0 THEN $1::bigint + $3::bigint ELSE cooldown_until END,
         updated_at = $1
     WHERE name = $4 AND ($5::text IS NULL OR (account_claimed_by=$5 AND account_busy_until>$1))`,
    [now, kind, cooldownMs, name, leaseOwner ?? null]
  );

  const row = await q1<{ ce: number }>(
    `SELECT consecutive_errors AS ce FROM x_accounts WHERE name=$1`, [name]
  );
  const shouldBan = row && kind === "ban";
  if (shouldBan) {
    log.error("account ban reported", { name, errors: row!.ce, kind });
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
       status='active', cooldown_until=0, consecutive_errors=0,
       health_score=NULL,last_check_at=NULL,last_check_json=NULL,
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

