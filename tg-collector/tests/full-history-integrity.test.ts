import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { extractLinks } from "../src/analytics/extract.js";
import type { TelegramClient } from "telegram";

test("hidden Telegram text_link URLs participate in evidence extraction", () => {
  const links = extractLinks({
    id: 1,
    message: "Official project",
    entities: [{
      className: "MessageEntityTextUrl", offset: 0, length: 16,
      url: "https://t.me/ExampleChannel/123",
    }],
  });
  assert.ok(links.some(link =>
    link.kind === "mention" && link.targetKind === "handle" && link.targetKey === "examplechannel"));
});

test("full-history resumes below the oldest persisted post and scans until an empty page", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const { pool, migrate } = await import("../src/db.js");
  const { processJob } = await import("../src/engines/channel.js");
  const handle = "history_" + randomUUID().replaceAll("-", "").slice(0, 17);
  const postedAt = Math.floor(new Date("2026-10-15T12:00:00Z").valueOf() / 1000);
  const originals = Array.from({length: 650}, (_, n) =>
    ({id: n + 1, date: postedAt + n, message: "Historical post #" + (n + 1)})).reverse();
  const client = {
    async getEntity() { return {className: "Channel", title: "History test channel", id: {toString: () => "123456"}}; },
    async getMessages(_entity: unknown, options: {limit: number;offsetId?: number;minId?: number}) {
      const offset = options.offsetId ?? Number.MAX_SAFE_INTEGER;
      // Intentional *short* nonterminal pages simulate Telegram gaps/deletions.
      const limit = Math.min(options.limit, 35);
      return originals.filter(row => row.id < offset && row.id > (options.minId ?? 0)).slice(0, limit);
    },
  } as unknown as TelegramClient;
  let sourceId = "";
  try {
    await migrate();
    const source = await pool.query<{id:string}>(
      "INSERT INTO tg_sources(identifier) VALUES($1) RETURNING id::text", [handle]);
    sourceId = source.rows[0].id;
    await pool.query("INSERT INTO tg_jobs(source_id) VALUES($1)", [sourceId]);

    const readJob = async () => {
      const result = await pool.query<{
        id: string;source_id:string;attempts:number;
        base_message_id:string|null; high_message_id:string|null;
        cursor_before_id:string|null;scanned_count:number;
      }>("SELECT * FROM tg_jobs WHERE source_id=$1", [sourceId]);
      return result.rows[0];
    };

    // Initial recent-only collection stops around the limit, not at a short page.
    await processJob(client, await readJob(), () => false);
    let initial = await pool.query<{count:number}>(
      "SELECT count(*)::integer AS count FROM tg_messages WHERE source_id=$1", [sourceId]);
    assert.ok(initial.rows[0].count >= 500 && initial.rows[0].count < 650);

    await pool.query("UPDATE tg_sources SET full_history=TRUE,history_partial=TRUE,history_complete=FALSE WHERE id=$1", [sourceId]);
    await pool.query(`UPDATE tg_jobs SET base_message_id=NULL,high_message_id=NULL,cursor_before_id=NULL,
      scanned_count=0,state='pending' WHERE source_id=$1`, [sourceId]);

    let complete = false;
    for (let turn = 0; turn < 30; turn++) {
      await processJob(client, await readJob(), () => false);
      const status = await pool.query<{history_complete:boolean}>(
        "SELECT history_complete FROM tg_sources WHERE id=$1", [sourceId]);
      if (status.rows[0].history_complete) { complete = true; break; }
    }
    assert.equal(complete, true, "full scan reaches the empty Telegram page");

    const state = await pool.query<{
      count:number;distinct_count:number;history_low_message_id:string;
      history_partial:boolean;history_complete:boolean;
    }>(`SELECT count(m.message_id)::integer AS count, count(DISTINCT m.message_id)::integer AS distinct_count,
        s.history_low_message_id::text, s.history_partial, s.history_complete
      FROM tg_sources s JOIN tg_messages m ON m.source_id=s.id
      WHERE s.id=$1 GROUP BY s.id`, [sourceId]);
    assert.equal(state.rows[0].count,650);
    assert.equal(state.rows[0].distinct_count,650);
    assert.equal(state.rows[0].history_low_message_id,"1");
    assert.equal(state.rows[0].history_partial,false);
    assert.equal(state.rows[0].history_complete,true);

    // Incremental rerun of the same latest page remains idempotent.
    await processJob(client, await readJob(), () => false);
    const after = await pool.query<{count:number}>(
      "SELECT count(*)::integer AS count FROM tg_messages WHERE source_id=$1", [sourceId]);
    assert.equal(after.rows[0].count,650);
  } finally {
    if (sourceId) await pool.query("DELETE FROM tg_sources WHERE id=$1", [sourceId]);
    await pool.end();
  }
});
