import { q1 } from "../../lib/trade/pg";

export interface CollectorAccount {
  name: string;
  session_encrypted: Buffer;
  proxy_json: string | null;
  user_agent: string | null;
  timezone: string | null;
  language?: string | null;
}

/**
 * Только чтение: аккаунт не резервируется и не трогает quota-счётчики —
 * резервирование остаётся за lib/trade/account-manager (worker).
 * Порядок выбора повторяет pickAccount: hot → warm → new, меньше загрузка,
 * дольше не использовался.
 */
export async function getCollectorAccount(): Promise<CollectorAccount | null> {
  const now = Date.now();
  return q1<CollectorAccount>(
    `SELECT name, session_encrypted, proxy_json, user_agent, timezone, language
     FROM x_accounts
     WHERE role='collector' AND status = 'active'
       AND tier != 'retired'
       AND cooldown_until < $1
       AND account_busy_until < $1
       AND (weight_used_this_hour < weight_quota_per_hour OR hour_window_start < $2)
     ORDER BY CASE tier WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 WHEN 'new' THEN 2 ELSE 3 END,
              weight_used_this_hour ASC,
              COALESCE(last_success_at, 0) ASC
     LIMIT 1`,
    [now, now - 3_600_000]
  );
}
