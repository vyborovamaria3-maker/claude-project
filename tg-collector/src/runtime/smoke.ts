import "dotenv/config";
import { pool, migrate } from "../db.js";
import { authorizedClient } from "../accounts/session.js";
import { normalizePublicUsername } from "../validation.js";
import { persistMessage } from "../persistence/messages.js";
import { refreshGraphDays, utcDay } from "../analytics/rollups.js";
import type { RawTelegramMessage } from "../analytics/extract.js";
import type { TelegramClient } from "telegram";

/**
 * Local live smoke test. Run with your own authorized Telegram account;
 * writes <=100 visible messages to PostgreSQL; does not send messages/invite users.
 */
async function main(): Promise<void> {
  const handle = normalizePublicUsername(process.argv[2] ?? "");
  await migrate();
  const guard = await pool.connect();
  let client: TelegramClient | undefined;
  try {
    const { rows } = await guard.query<{acquired:boolean}>(
      "SELECT pg_try_advisory_lock(8260226) AS acquired");
    if (!rows[0]?.acquired) throw Error("Stop the TG Collector worker before the smoke test.");
    client = await authorizedClient();
    const entity = await client.getEntity(handle);
    const info = entity as { className?: string };
    if (info.className !== "Channel") throw Error("A public channel or supergroup is required.");
    const batch = await client.getMessages(entity, {limit:100});
    const all = batch as unknown as RawTelegramMessage[];
    const messages = all.filter(m=>Number.isSafeInteger(m.id) && m.id>0 && typeof m.message==="string");
    if (!messages.length) throw Error("No accessible messages with a text field returned.");
    const tx = await pool.connect();
    let sourceId = "";
    try {
      await tx.query("BEGIN");
      const found = await tx.query<{id:string}>(
        "INSERT INTO tg_sources(identifier) VALUES ($1) ON CONFLICT(identifier) DO UPDATE SET enabled=TRUE RETURNING id::text", [handle]);
      sourceId = found.rows[0].id;
      const old = await tx.query<{posted_at:Date|null}>(
        "SELECT posted_at FROM tg_messages WHERE source_id=$1 AND message_id=ANY($2::bigint[])",
        [sourceId, messages.map(m=>m.id)]);
      const days = old.rows.map(r=>utcDay(r.posted_at)).filter((d):d is string=>d!==null);
      for (const msg of messages) {
        await persistMessage(tx,sourceId,msg);
        const day = typeof msg.date==="number" ? utcDay(new Date(msg.date*1000)) : null;
        if (day) days.push(day);
      }
      await refreshGraphDays(tx,sourceId,days);
      await tx.query(
        "INSERT INTO tg_jobs(source_id) VALUES($1) ON CONFLICT(source_id) DO NOTHING", [sourceId]);
      await tx.query("COMMIT");
    } catch(error) {
      await tx.query("ROLLBACK"); throw error;
    } finally { tx.release(); }

    const ids = messages.map(m=>m.id);
    const [saved, evidence] = await Promise.all([
      pool.query<{count:number}>(
        "SELECT count(*)::int AS count FROM tg_messages WHERE source_id=$1 AND message_id=ANY($2::bigint[])",
        [sourceId,ids]),
      pool.query<{kind:string;count:number}>(
        "SELECT kind,count(*)::int AS count FROM tg_message_links WHERE source_id=$1 AND message_id=ANY($2::bigint[]) GROUP BY kind ORDER BY kind",
        [sourceId,ids]),
    ]);
    if (saved.rows[0].count !== messages.length) {
      throw Error("Mismatch between received messages and PostgreSQL persistence.");
    }
    console.log(JSON.stringify({
      source: "@"+handle, received: all.length, persisted: saved.rows[0].count,
      firstFiveMessageIds: ids.slice(0,5), evidence: evidence.rows,
      note: "Verify these message IDs against Telegram manually. Historical completeness is not proven.",
    }, null, 2));
  } finally {
    if (client) await client.disconnect();
    try { await guard.query("SELECT pg_advisory_unlock(8260226)"); }
    finally { guard.release(); await pool.end(); }
  }
}
main().catch(error=>{
  console.error("Telegram smoke check failed:", error instanceof Error ? error.message : String(error));
  process.exitCode=1;
});
