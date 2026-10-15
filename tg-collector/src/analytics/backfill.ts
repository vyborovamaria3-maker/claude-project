import "dotenv/config";
import { pool, migrate } from "../db.js";
import { replaceEvidence } from "../persistence/messages.js";
import { ANALYSIS_VERSION } from "./extract.js";

/**
 * Offline reindex of existing messages. No Telegram calls.
 * A row's version is updated in the same transaction as its derived evidence.
 */
async function main(): Promise<void> {
  await migrate();
  const lock = await pool.connect();
  let processed = 0;
  try {
    const result = await lock.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(8260227) AS acquired"
    );
    if (!result.rows[0]?.acquired) throw new Error("Analysis backfill already running");
    while (true) {
      const client = await pool.connect();
      let count = 0;
      try {
        await client.query("BEGIN");
        const { rows } = await client.query<{
          source_id: string; message_id: string; text: string;
        }>(`SELECT source_id::text, message_id::text, text
              FROM tg_messages WHERE analysis_version < $1
              ORDER BY source_id, message_id FOR UPDATE SKIP LOCKED LIMIT 100`,
          [ANALYSIS_VERSION]);
        for (const row of rows) {
          await replaceEvidence(client, row.source_id, {
            id: Number(row.message_id), message: row.text,
          });
          count++;
        }
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
    try { await lock.query("SELECT pg_advisory_unlock(8260227)"); }
    finally { lock.release(); await pool.end(); }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
