import "dotenv/config";
import { pool, migrate } from "../db.js";
import { createHash } from "node:crypto";
import { extractLinks } from "../analytics/extract.js";
import { authorizedClient } from "../accounts/session.js";
import { normalizePublicUsername, verifiedPublicUsername } from "../validation.js";
import { persistMessage } from "../persistence/messages.js";
import { refreshGraphDays, utcDay } from "../analytics/rollups.js";
import type { RawTelegramMessage } from "../analytics/extract.js";
import type { TelegramClient } from "telegram";

/**
 * Local live smoke test. Run with your own authorized Telegram account;
 * writes <=100 visible messages to PostgreSQL; does not send messages/invite users.
 */
async function main(): Promise<void> {
  const configuredHandle = process.argv[2] ?? process.env.TG_SMOKE_TEST_CHANNEL ?? "";
  if (!configuredHandle) {
    throw Error("Set TG_SMOKE_TEST_CHANNEL or pass a dedicated public test channel as the first argument.");
  }
  const handle = normalizePublicUsername(configuredHandle);
  const expectedMessages = Number(process.env.TG_SMOKE_EXPECTED_MESSAGES ?? "100");
  if (!Number.isSafeInteger(expectedMessages) || expectedMessages < 1 || expectedMessages > 100) {
    throw Error("TG_SMOKE_EXPECTED_MESSAGES must be an integer between 1 and 100.");
  }
  await migrate();
  const guard = await pool.connect();
  let client: TelegramClient | undefined;
  try {
    const { rows } = await guard.query<{acquired:boolean}>(
      "SELECT pg_try_advisory_lock(8260226) AS acquired");
    if (!rows[0]?.acquired) throw Error("Stop the TG Collector worker before the smoke test.");
    client = await authorizedClient();
    const entity = await client.getEntity(handle);
    const info = entity as {
      className?: string;
      id?: {toString(): string};
      accessHash?: {toString(): string};
      username?: string;
      usernames?: Array<{username?: string; active?: boolean}>;
    };
    const verifiedPeer = info.id?.toString();
    const verifiedHandle = verifiedPublicUsername(info);
    if (info.className !== "Channel" || !verifiedPeer || !verifiedHandle) {
      throw Error("TG_SMOKE_PUBLIC_PEER_REQUIRED: a verified public channel or supergroup is required.");
    }
    const currentUsername = normalizePublicUsername(verifiedHandle);
    const batch = await client.getMessages(entity, {limit:expectedMessages});
    const all = batch as unknown as RawTelegramMessage[];
    const messages = all.filter(m=>Number.isSafeInteger(m.id) && m.id>0 && typeof m.message==="string");
    if (messages.length < expectedMessages) {
      throw Error(`Smoke channel returned ${messages.length} text messages; expected at least ${expectedMessages}. Keep the smoke channel deterministic and seeded with stable public test posts.`);
    }
    const tx = await pool.connect();
    let sourceId = "";
    try {
      await tx.query("BEGIN");
      // The smoke tool also writes canonical evidence. A reassigned @username
      // must never let a smoke run mix two unrelated Telegram channels.
      const matches = await tx.query<{id:string;peer_id:string|null;has_evidence:boolean}>(`
        SELECT s.id::text,s.peer_id,
          (EXISTS(SELECT 1 FROM tg_messages m WHERE m.source_id=s.id) OR
           EXISTS(SELECT 1 FROM tg_discovery_mentions dm WHERE dm.source_id=s.id)) AS has_evidence
        FROM tg_sources s
        WHERE s.peer_id=$1 OR s.identifier=$2 OR s.current_username=$2
        FOR UPDATE OF s`, [verifiedPeer,handle]);
      if (matches.rows.length > 1 ||
          matches.rows.some(row => row.peer_id !== null && row.peer_id !== verifiedPeer)) {
        throw Error("TG_SMOKE_IDENTITY_CONFLICT: username belongs to a different tracked peer; use an isolated test database.");
      }
      const previous = matches.rows[0];
      if (previous && !previous.peer_id && previous.has_evidence) {
        throw Error("TG_SMOKE_UNVERIFIED_HISTORY: cannot attribute existing unverified messages to a new Telegram peer.");
      }
      const found = previous
        ? await tx.query<{id:string}>(`
            UPDATE tg_sources SET peer_id=$2,access_hash=COALESCE($3,access_hash),
              current_username=$4 WHERE id=$1 RETURNING id::text`,
            [previous.id,verifiedPeer,info.accessHash?.toString()??null,currentUsername])
        : await tx.query<{id:string}>(`
            INSERT INTO tg_sources(identifier,peer_id,access_hash,current_username)
            VALUES($1,$2,$3,$4) RETURNING id::text`,
            [handle,verifiedPeer,info.accessHash?.toString()??null,currentUsername]);
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
    // Compare actual PostgreSQL fields and extracted links with the Telegram batch.
    const persisted = await pool.query<{
      message_id: string;posted_at: Date|null;text:string;views:number|null;
      forwards:number|null;replies:number|null;
    }>(`SELECT message_id::text,posted_at,text,views,forwards,replies
      FROM tg_messages WHERE source_id=$1 AND message_id=ANY($2::bigint[])`,[sourceId,ids]);
    const savedById = new Map(persisted.rows.map(row => [row.message_id,row]));
    for (const msg of messages) {
      const row = savedById.get(String(msg.id));
      if (!row) throw Error("Missing Telegram message in PostgreSQL: " + msg.id);
      const postedAt = typeof msg.date === "number" ? new Date(msg.date*1000).getTime() : null;
      const savedAt = row.posted_at ? new Date(row.posted_at).getTime() : null;
      if (row.text !== msg.message || postedAt !== savedAt ||
          row.views !== (msg.views ?? null) ||
          row.forwards !== (msg.forwards ?? null) ||
          row.replies !== (msg.replies?.replies ?? null)) {
        throw Error("Telegram/PostgreSQL field mismatch for message ID " + msg.id);
      }
      const expected = extractLinks(msg).map(link =>
        [link.kind,link.targetKind,link.targetKey].join(":")).sort();
      const actual = await pool.query<{kind:string;target_kind:string;target_key:string}>(
        "SELECT kind,target_kind,target_key FROM tg_message_links WHERE source_id=$1 AND message_id=$2",
        [sourceId,msg.id]);
      const actualKeys = actual.rows.map(link =>
        [link.kind,link.target_kind,link.target_key].join(":")).sort();
      if (expected.join("|") !== actualKeys.join("|"))
        throw Error("Telegram/PostgreSQL evidence mismatch for message ID " + msg.id);
    }
    // Replay the same messages: neither message count nor evidence count may grow.
    const before = await pool.query<{messages:number;links:number}>(`
      SELECT (SELECT count(*)::integer FROM tg_messages WHERE source_id=$1) AS messages,
             (SELECT count(*)::integer FROM tg_message_links WHERE source_id=$1) AS links`,[sourceId]);
    const replay = await pool.connect();
    try {
      await replay.query("BEGIN");
      for (const msg of messages) await persistMessage(replay,sourceId,msg);
      await replay.query("COMMIT");
    } catch (error) { await replay.query("ROLLBACK");throw error; }
    finally { replay.release(); }
    const after = await pool.query<{messages:number;links:number}>(`
      SELECT (SELECT count(*)::integer FROM tg_messages WHERE source_id=$1) AS messages,
             (SELECT count(*)::integer FROM tg_message_links WHERE source_id=$1) AS links`,[sourceId]);
    if (before.rows[0].messages !== after.rows[0].messages ||
        before.rows[0].links !== after.rows[0].links)
      throw Error("Smoke replay is not idempotent");
    const sample = messages.slice(0,5).map(msg=>({
      id:msg.id,
      textSha256:createHash("sha256").update(msg.message ?? "").digest("hex"),
    }));

    console.log(JSON.stringify({
      source: "@"+handle, expectedMessages, received: all.length, persisted: saved.rows[0].count,
      firstFiveMessageIds: ids.slice(0,5), sample, evidence: evidence.rows,
      replayIdempotent: true, telegramFieldComparison: "passed",
      note: "This validates fetched message fields and evidence but does not prove completeness of full channel history.",
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
