import { q1, exec } from "../../lib/trade/pg";
import { WEIGHTS, type RequestKind } from "../../lib/trade/account-manager";

/**
 * pickAccount already charges one weighted task allowance. Consume that first,
 * then debit one additional unit for each further HTTP request. This remains
 * one shared account quota; no independent XActions pool or quota is created.
 */
export function createHttpQuotaGate(
  kind: RequestKind,
  reserveExtra: () => Promise<boolean>,
): () => Promise<void> {
  let prepaid = WEIGHTS[kind];
  return async () => {
    if (prepaid > 0) {
      prepaid--;
      return;
    }
    if (!(await reserveExtra())) throw new HttpAccountQuotaError();
  };
}

export class HttpAccountQuotaError extends Error {
  constructor() {
    super("XACTIONS_QUOTA_EXHAUSTED");
    this.name = "HttpAccountQuotaError";
  }
}

/** A single atomic increment, limited by quota and the caller's current lease. */
export async function reserveAdditionalHttpRequest(accountName: string, leaseOwner: string): Promise<boolean> {
  const now = Date.now();
  const changed = await exec(
    `UPDATE x_accounts SET
      weight_used_this_hour = CASE WHEN hour_window_start < $3 THEN 1 ELSE weight_used_this_hour+1 END,
      hour_window_start = CASE WHEN hour_window_start < $3 THEN $4 ELSE hour_window_start END,
      total_requests=total_requests+1, updated_at=$4
     WHERE name=$1 AND account_claimed_by=$2 AND account_busy_until > $4
       AND status='active' AND role='collector'
       AND (CASE WHEN hour_window_start < $3 THEN 1 ELSE weight_used_this_hour+1 END) <= weight_quota_per_hour`,
    [accountName, leaseOwner, now-3600000, now],
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
