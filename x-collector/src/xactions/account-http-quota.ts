import { q1, exec } from "../../lib/trade/pg";
import { WEIGHTS, type RequestKind } from "../../lib/trade/account-manager";

/**
 * pickAccount pre-charges ONE weighted operation for the task. Consume it
 * for the first HTTP call. Every additional call must reserve that same
 * operation's weight. Never treat a timeline weight of 5 as five free calls.
 * The reservation is shared with browser tasks in the same account quota.
 */
export function createHttpQuotaGate(
  kind: RequestKind,
  reserveExtra: (weight: number) => Promise<boolean>,
): () => Promise<void> {
  let firstCallCovered = true;
  return async () => {
    if (firstCallCovered) {
      firstCallCovered = false;
      return;
    }
    if (!(await reserveExtra(WEIGHTS[kind]))) throw new HttpAccountQuotaError();
  };
}

export class HttpAccountQuotaError extends Error {
  constructor() {
    super("XACTIONS_QUOTA_EXHAUSTED");
    this.name = "HttpAccountQuotaError";
  }
}

/** A single atomic increment, limited by quota and the caller's current lease. */
export async function reserveAdditionalHttpRequest(accountName: string, leaseOwner: string, weight: number): Promise<boolean> {
  if (!Number.isSafeInteger(weight) || weight < 1 || weight > 100) {
    throw new Error("XActions: invalid HTTP quota weight");
  }
  const now = Date.now();
  const changed = await exec(
    `UPDATE x_accounts SET
      weight_used_this_hour = CASE WHEN hour_window_start < $3 THEN $5 ELSE weight_used_this_hour+$5 END,
      hour_window_start = CASE WHEN hour_window_start < $3 THEN $4 ELSE hour_window_start END,
      total_requests=total_requests+1, updated_at=$4
     WHERE name=$1 AND account_claimed_by=$2 AND account_busy_until > $4
       AND status='active' AND role='collector'
       AND (CASE WHEN hour_window_start < $3 THEN $5 ELSE weight_used_this_hour+$5 END) <= weight_quota_per_hour`,
    [accountName, leaseOwner, now-3600000, now, weight],
  );
  return changed === 1;
}

export async function httpQuotaWaitMs(accountName: string): Promise<number> {
  const row = await q1<{ hour_window_start: string }>(
    "SELECT hour_window_start::text FROM x_accounts WHERE name=$1", [accountName],
  );
  const time = Number(row?.hour_window_start ?? 0) + 3600000 - Date.now();
  return Number.isFinite(time) ? Math.max(5000, Math.min(3600000, time + 1000)) : 60000;
}
