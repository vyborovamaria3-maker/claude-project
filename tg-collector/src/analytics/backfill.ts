import "dotenv/config";
import { pool, migrate } from "../db.js";
import { replaceEvidence } from "../persistence/messages.js";
import { ANALYSIS_VERSION } from "./extract.js";
import { refreshGraphDays, utcDay } from "./rollups.js";

/**
 * Offline reindex of existing messages. No Telegram calls.
 * A row's version is updated in the same transaction as its derived evidence.
 */
async function main(): Promise<void> {
  await migrate();
  const lock = await pool.connect();
  const batchArg = process.argv.find((arg) => arg.startsWith("--batch-size="))?.slice("--batch-size=".length);
  const batchSize = batchArg === undefined ? 1000 : Number(batchArg);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10000) throw new Error("--batch-size must be an integer from 1 to 10000");
  let processed = 0;
  try {
    const result = await lock.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(8260226) AS acquired"
    );
    if (!result.rows[0]?.acquired) throw new Error("Stop the Telegram collector worker or other analytics task before backfill");
    while (true) {
      const client = await pool.connect();
      let count = 0;
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<{
          source_id: string; message_id: string; text: string; posted_at: Date | null;
        }>(`SELECT source_id::text, message_id::text, text, posted_at
              FROM tg_messages WHERE analysis_version < $1
              ORDER BY source_id, message_id FOR UPDATE SKIP LOCKED LIMIT $2`,
          [ANALYSIS_VERSION, batchSize]);
        const affected = new Map<string, string[]>();
        for (const row of rows) {
          await replaceEvidence(client, row.source_id, {
            id: Number(row.message_id), message: row.text,
          }, { preserveExistingForwards: true });
          const day = utcDay(row.posted_at);
          if (day) affected.set(row.source_id, [...(affected.get(row.source_id) ?? []), day]);
          count++;
        }
        for (const [sourceId, days] of affected) await refreshGraphDays(client, sourceId, days);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
      if (count === 0) break;
      processed += count;
      if (processed % 1000 === 0) console.log("Analyzed messages:", processed);
    }
    console.log("Backfill completed:", processed, "messages");
  } finally {
    try { await lock.query("SELECT pg_advisory_unlock(8260226)"); }
    finally { lock.release(); await pool.end(); }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
