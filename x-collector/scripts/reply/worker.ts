import "dotenv/config";
// Each process owns its pool. Avoid 20 connections per account worker.
process.env.PG_POOL_MAX ??= "3";
import { getPool, q1, q, closePool } from "../../lib/trade/pg";
import { Account, Campaign, Settings, sleeping } from "../../lib/reply/model";
import {
  healthCheck,
  collect,
  draftReplies,
  publishNext,
} from "../../lib/reply/engine";
import { alert } from "../../lib/reply/service";
import { log, closeLogger } from "../../lib/trade/logger";
let stopped = false;
process.on("SIGINT", () => {
  stopped = true;
});
process.on("SIGTERM", () => {
  stopped = true;
});
async function main() {
  const id = process.argv[2];
  if (!id || !/^\d+$/.test(id))
    throw new Error("usage: reply:worker ACCOUNT_ID");
  if (!Number.isInteger(Number(process.env.PG_POOL_MAX)) || Number(process.env.PG_POOL_MAX) < 2)
    throw new Error("Reply worker requires PG_POOL_MAX >= 2 (lock + queries)");
  // One long-lived DB session owns one account for the lifetime of this process.
  const lock = await getPool().connect();
  const key = "reply-worker:" + id;
  try {
    const result = await lock.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)::bigint) locked",
      [key],
    );
    if (!result.rows[0]?.locked)
      throw new Error("account worker already running");
    lock.on("error", () => {
      stopped = true;
      log.error("reply worker lock connection lost");
    });
    // A previous process may have died after POST. Never auto-retry that publication.
    await q(
      "UPDATE reply_drafts SET status='uncertain',last_error='worker stopped during publication; reconcile manually' WHERE account_id=$1 AND status='publishing'",
      [id],
    );
    let nextHealth = 0;
    while (!stopped) {
      const account = await q1<Account>(
        "SELECT * FROM reply_accounts WHERE id=$1",
        [id],
      );
      if (!account) break;
      const campaign = await q1<Campaign>(
        "SELECT * FROM reply_campaigns WHERE account_id=$1",
        [id],
      );
      if (
        !campaign ||
        campaign.status !== "running" ||
        account.status !== "ready"
      )
        break;
      if (
        (account.cooldown_until &&
          Date.parse(account.cooldown_until) > Date.now()) ||
        sleeping(Settings.parse(campaign.settings_json), account.timezone)
      ) {
        await pause(1000);
        continue;
      }
      try {
        // Round trip on lock session; a lost session stops work before next external call.
        await lock.query("SELECT 1");
        if (Date.now() >= nextHealth) {
          if (!(await healthCheck(account))) {
            await pause(30000);
            continue;
          }
          nextHealth = Date.now() + 5 * 60000;
        }
        await collect(campaign, account);
        const fresh = await q1<Account>(
          "SELECT * FROM reply_accounts WHERE id=$1",
          [id],
        );
        const current = await q1<Campaign>(
          "SELECT * FROM reply_campaigns WHERE account_id=$1",
          [id],
        );
        if (
          fresh?.status === "ready" &&
          current?.status === "running" &&
          (!fresh.cooldown_until ||
            Date.parse(fresh.cooldown_until) <= Date.now())
        ) {
          await draftReplies(current, fresh);
          if (!stopped) {
            await lock.query("SELECT 1");
            await publishNext(fresh);
          }
        }
      } catch {
        await alert(
          account.user_id,
          id,
          "worker_error",
          "Worker cycle failed; inspect service configuration",
        );
        log.error("reply worker cycle failed", { accountId: id });
      }
      await pause(30000);
    }
  } finally {
    await lock
      .query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [key])
      .catch(() => {});
    lock.release();
    await closePool();
    closeLogger();
  }
}
async function pause(ms: number) {
  const end = Date.now() + ms;
  while (!stopped && Date.now() < end)
    await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())));
}
main().catch(() => {
  log.error("reply worker stopped");
  process.exitCode = 1;
});
