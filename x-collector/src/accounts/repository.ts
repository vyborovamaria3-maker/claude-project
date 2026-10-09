import { q, exec } from "../../lib/trade/pg";

export interface XAccount {
  name: string;
  status: string;
  weightQuota: number;
}

export async function getAvailableAccount(): Promise<XAccount | null> {
  const rows = await q<XAccount>(
    `SELECT name, status, weight_quota_per_hour as "weightQuota"
     FROM x_accounts
     WHERE status = 'active'
       AND cooldown_until < $1
       AND account_busy_until < $1
       AND weight_used_this_hour < weight_quota_per_hour
     ORDER BY weight_used_this_hour ASC
     LIMIT 1`,
    [Date.now()]
  );
  return rows[0] ?? null;
}

export async function markUsed(name: string): Promise<void> {
  await exec(
    `UPDATE x_accounts
     SET weight_used_this_hour = weight_used_this_hour + 1,
         updated_at = $2
     WHERE name = $1`,
    [name, Date.now()]
  );
}
