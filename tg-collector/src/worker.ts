import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import { pool, migrate } from "./db.js";
import { authorizedClient } from "./telegram.js";
import type { TelegramClient } from "telegram";

type Job = {
  id: string; source_id: string; attempts: number;
  base_message_id: string | null; high_message_id: string | null;
  cursor_before_id: string | null; scanned_count: number;
};
type Source = { identifier: string; last_message_id: string };
type TgMessage = {
  id: number; message?: string; senderId?: { toString(): string };
  date?: number; views?: number; forwards?: number;
  replies?: { replies?: number };
};

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}: ${n}`);
  return n;
}
const pollSeconds = envInt("TG_POLL_SECONDS", 300, 30, 86400);
const batchSize = envInt("TG_BATCH_SIZE", 100, 1, 100);
const maxPages = envInt("TG_MAX_PAGES_PER_JOB", 20, 1, 100);
const initialLimit = envInt("TG_INITIAL_MESSAGE_LIMIT", 500, 1, 100000);
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

async function claim(): Promise<Job | undefined> {
  const { rows } = await pool.query<Job>(`
    WITH pick AS (
      SELECT id FROM tg_jobs
      WHERE (state IN ('pending','delayed') AND run_at <= now())
         OR (state='running' AND locked_until < now())
      ORDER BY run_at, id
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE tg_jobs j SET state='running', attempts=attempts+1,
           locked_until=now()+interval '15 minutes', updated_at=now()
    FROM pick WHERE j.id=pick.id
    RETURNING j.*`);
  return rows[0];
}

async function finishJob(job: Job, highId: number, partial: boolean): Promise<void> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query(
      `UPDATE tg_sources SET last_message_id=GREATEST(last_message_id,$2),
        history_partial=history_partial OR $3, last_success_at=now()
        WHERE id=$1`, [job.source_id, highId, partial]
    );
    await tx.query(`UPDATE tg_jobs SET state='pending', attempts=0,
      base_message_id=NULL, high_message_id=NULL, cursor_before_id=NULL,
      scanned_count=0, run_at=now()+($2::int * interval '1 second'),
      locked_until=NULL, last_error=NULL, updated_at=now() WHERE id=$1`,
      [job.id, pollSeconds]);
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally { tx.release(); }
}

async function storePage(job: Job, rows: TgMessage[], lowId: number): Promise<void> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    for (const msg of rows) {
      // Telegram's service events and deleted placeholders have no message text.
      if (typeof msg.message !== "string") continue;
      await tx.query(
        `INSERT INTO tg_messages(source_id,message_id,sender_id,posted_at,text,views,forwards,replies)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(source_id,message_id) DO UPDATE SET
           sender_id=EXCLUDED.sender_id, posted_at=EXCLUDED.posted_at,
           text=EXCLUDED.text, views=EXCLUDED.views,
           forwards=EXCLUDED.forwards, replies=EXCLUDED.replies,
           collected_at=now()`,
        [job.source_id, msg.id, msg.senderId?.toString() ?? null,
         typeof msg.date === "number" ? new Date(msg.date*1000) : null,
         msg.message, msg.views ?? null, msg.forwards ?? null,
         msg.replies?.replies ?? null]
      );
    }
    await tx.query(`UPDATE tg_jobs SET cursor_before_id=$2,
      scanned_count=scanned_count+$3, locked_until=now()+interval '15 minutes',
      updated_at=now() WHERE id=$1`, [job.id, lowId, rows.length]);
    await tx.query("COMMIT");
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally { tx.release(); }
}

async function processJob(client: TelegramClient, job: Job): Promise<void> {
  const { rows } = await pool.query<Source>(
    "SELECT identifier,last_message_id FROM tg_sources WHERE id=$1", [job.source_id]);
  const source = rows[0];
  if (!source) throw new Error("Source was deleted");

  const entity = await client.getEntity(source.identifier);
  const channel = entity as { id?: {toString(): string}; title?: string };
  await pool.query("UPDATE tg_sources SET peer_id=$2,title=$3 WHERE id=$1",
    [job.source_id, channel.id?.toString() ?? null, channel.title ?? source.identifier]);

  const baseId = Number(job.base_message_id ?? source.last_message_id);
  let highId = job.high_message_id ? Number(job.high_message_id) : 0;
  let cursor = job.cursor_before_id ? Number(job.cursor_before_id) : 0;
  let scanned = job.scanned_count;

  if (!job.high_message_id) {
    const latest = await client.getMessages(entity, {limit:1});
    highId = latest[0]?.id ?? 0;
    await pool.query(
      "UPDATE tg_jobs SET base_message_id=$2,high_message_id=$3,updated_at=now() WHERE id=$1",
      [job.id, baseId, highId]
    );
  }

  if (highId <= baseId) {
    await finishJob(job, Math.max(baseId, highId), false);
    return;
  }

  for (let page=0; page<maxPages && !stopping; page++) {
    const batch = await client.getMessages(entity, {
      limit: batchSize,
      offsetId: cursor || highId+1,
      minId: baseId,
    });
    const messages = batch as unknown as TgMessage[];
    if (!messages.length) {
      await finishJob(job, highId, false);
      console.log("Synced", source.identifier, "to", highId);
      return;
    }
    const lowId = Math.min(...messages.map(m=>m.id));
    if (!Number.isFinite(lowId) || (cursor && lowId >= cursor)) {
      throw new Error("Telegram history cursor did not advance");
    }
    await storePage(job, messages, lowId);
    cursor=lowId;
    scanned+=messages.length;
    const initialCutoff = baseId === 0 && scanned >= initialLimit;
    if (messages.length < batchSize || initialCutoff) {
      await finishJob(job, highId, initialCutoff && messages.length===batchSize);
      console.log("Synced", source.identifier, messages.length, "latest batch", "high", highId);
      return;
    }
    await sleep(250);
  }
  // The checkpoint is not advanced until the whole new-message range is captured.
  await pool.query(`UPDATE tg_jobs SET state='pending',
    attempts=0, locked_until=NULL, run_at=now()+interval '5 seconds',
    updated_at=now() WHERE id=$1`, [job.id]);
}

function floodSeconds(error: unknown): number | null {
  const e = error as { seconds?: unknown; message?: string };
  if (typeof e?.seconds === "number" && e.seconds > 0) return Math.ceil(e.seconds);
  const match = String(e?.message ?? error).match(/FLOOD_WAIT_?(\d+)/i);
  return match ? Number(match[1]) : null;
}

async function handleFailure(job: Job, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0,300);
  const seconds = floodSeconds(error);
  if (seconds !== null) {
    const wait = Math.min(seconds + 15, 86400 * 30);
    await pool.query(
      "UPDATE tg_runtime SET pause_until=GREATEST(COALESCE(pause_until, now()), now()+($1::int * interval '1 second')) WHERE id=1",
      [wait]);
    await pool.query(`UPDATE tg_jobs SET state='delayed',run_at=now()+($2::int * interval '1 second'),
      locked_until=NULL,last_error=$3,updated_at=now() WHERE id=$1`, [job.id, wait, "FLOOD_WAIT"]);
    console.warn("Telegram requested a pause (seconds):", seconds);
    return;
  }
  const permanent = /CHANNEL_PRIVATE|USERNAME_INVALID|USERNAME_NOT_OCCUPIED|CHAT_ADMIN_REQUIRED|USER_NOT_PARTICIPANT/.test(message);
  const retry = !permanent && job.attempts < 5;
  const wait = Math.min(900, Math.pow(2, job.attempts) * 15);
  await pool.query(`UPDATE tg_jobs SET state=$2,run_at=now()+($3::int * interval '1 second'),
    locked_until=NULL,last_error=$4,updated_at=now() WHERE id=$1`,
    [job.id, retry ? "delayed" : "failed", wait, message]);
  console.error("TG job error:", job.id, message);
}

async function main(): Promise<void> {
  await migrate();
  const guard = await pool.connect();
  let client: TelegramClient | undefined;
  try {
    const { rows } = await guard.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(8260226) AS acquired");
    if (!rows[0]?.acquired) throw new Error("Another TG Collector worker is already running");
    client = await authorizedClient();
    console.log("TG Collector worker started");
    while (!stopping) {
      const pause = await pool.query<{ wait_seconds: number }>(
        "SELECT GREATEST(0,EXTRACT(EPOCH FROM (pause_until-now())))::float8 AS wait_seconds FROM tg_runtime WHERE id=1");
      const seconds = Number(pause.rows[0]?.wait_seconds ?? 0);
      if (seconds > 0) { await sleep(Math.min(seconds*1000,60000)); continue; }
      const job = await claim();
      if (!job) { await sleep(3000); continue; }
      try { await processJob(client,job); }
      catch(error) { await handleFailure(job,error); }
    }
  } finally {
    if (client) await client.disconnect();
    try { await guard.query("SELECT pg_advisory_unlock(8260226)"); } finally { guard.release(); await pool.end(); }
  }
}
main().catch(error=>{console.error("Worker fatal:", error instanceof Error ? error.message : String(error)); process.exitCode=1;});
