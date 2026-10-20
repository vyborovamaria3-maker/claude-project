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

test("legacy messages cannot be assigned to a newly resolved username owner without peer provenance", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const { pool, migrate } = await import("../src/db.js");
  const { processJob } = await import("../src/engines/channel.js");
  await migrate();
  const handle = "legacy_" + randomUUID().replaceAll("-", "").slice(0, 12);
  const source = await pool.query<{id:string}>(`
    INSERT INTO tg_sources(identifier,last_message_id,history_low_message_id)
    VALUES($1,100,1) RETURNING id::text`, [handle]);
  const sourceId = source.rows[0].id;
  try {
    const job = await pool.query(`
      INSERT INTO tg_jobs(source_id) VALUES($1) RETURNING *`, [sourceId]);
    // Historical discovery linked source_id by username: this apparent peer
    // association must not authorize ownership of an unverified archive.
    await pool.query(`
      INSERT INTO tg_discovered_sources(peer_id,username,title,keyword,source_id)
      VALUES('123456',$1,'Stale username association','test',$2)`, [handle,sourceId]);
    const client = {
      async getEntity() {
        return {className:"Channel",id:{toString:()=> "123456"},
          accessHash:{toString:()=> "654321"},username:"verified_legacy"};
      },
      async getMessages() {throw Error("Must not fetch unverified legacy history");},
    } as unknown as TelegramClient;
    await assert.rejects(
      processJob(client, job.rows[0], () => false),
      /TG_SOURCE_IDENTITY_UNVERIFIED/,
    );
    const check = await pool.query<{peer_id:string|null}>(
      "SELECT peer_id FROM tg_sources WHERE id=$1", [sourceId]);
    assert.equal(check.rows[0].peer_id,null);
  } finally {
    await pool.query("DELETE FROM tg_discovered_sources WHERE peer_id='123456' AND source_id=$1",[sourceId]);
    await pool.query("DELETE FROM tg_sources WHERE id=$1",[sourceId]);
  }
});

test("an unverified source with only a persisted job checkpoint cannot switch Telegram identity", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const { pool,migrate } = await import("../src/db.js");
  const { processJob } = await import("../src/engines/channel.js");
  await migrate();
  const identifier = "checkpoint_" + randomUUID().replaceAll("-","").slice(0,14);
  const source = await pool.query<{id:string}>(
    "INSERT INTO tg_sources(identifier) VALUES($1) RETURNING id::text",[identifier]);
  const sourceId = source.rows[0].id;
  try {
    const job = await pool.query(`INSERT INTO tg_jobs
      (source_id,base_message_id,high_message_id,cursor_before_id)
      VALUES($1,0,850,800) RETURNING *`, [sourceId]);
    const telegram = {
      async getEntity() {
        return {className:"Channel",id:{toString:()=> "902101"},
          username:"checkpoint_public",title:"Unverified fixture"};
      },
      async getMessages() {throw Error("Must not fetch on unverified checkpoint");},
    } as unknown as TelegramClient;
    await assert.rejects(processJob(telegram,job.rows[0],()=>false),
      /TG_SOURCE_IDENTITY_UNVERIFIED/);
    const actual = await pool.query<{peer_id:string|null;last_message_id:string}>(
      "SELECT peer_id,last_message_id::text FROM tg_sources WHERE id=$1",[sourceId]);
    assert.equal(actual.rows[0].peer_id,null);
    assert.equal(actual.rows[0].last_message_id,"0");
  } finally {
    await pool.query("DELETE FROM tg_sources WHERE id=$1",[sourceId]);
  }
});

test("full-history scans gaps above isolated old discovery evidence", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const {pool,migrate} = await import("../src/db.js");
  const {processJob} = await import("../src/engines/channel.js");
  await migrate();
  const handle="sparse_"+randomUUID().replaceAll("-","").slice(0,12);
  const source=(await pool.query<{id:string}>(`
    INSERT INTO tg_sources(identifier,peer_id,current_username,
      full_history,history_partial,history_low_message_id,last_message_id)
    VALUES($1,'787878',$1,TRUE,TRUE,10,100) RETURNING id::text`,
    [handle])).rows[0].id;
  try {
    // This old post may have been discovered independently while IDs 11–89
    // were never scanned. Old code incorrectly treated minimum ID=10 as
    // proof that everything above 10 was already collected.
    await pool.query(`INSERT INTO tg_messages(source_id,message_id,text,posted_at)
      VALUES($1,10,'isolated old post',now()),($1,100,'latest post',now())`,
      [source]);
    const job=(await pool.query(`
      INSERT INTO tg_jobs(source_id) VALUES($1) RETURNING *`,[source])).rows[0];
    const history=Array.from({length:100},(_,i)=>({
      id:100-i,message:"Gap post "+String(100-i),date:1792065600+i,
    }));
    const client={
      async getEntity(){return {className:"Channel",
        id:{toString:()=> "787878"},username:handle,title:"Public fixture"};},
      async getMessages(_entity:unknown,opts:{limit:number;offsetId?:number;minId?:number}){
        return history.filter(msg=>msg.id<(opts.offsetId??Infinity) &&
          msg.id>(opts.minId??0)).slice(0,opts.limit);
      },
    } as unknown as TelegramClient;
    for(let turn=0;turn<6;turn++){
      const current=(await pool.query("SELECT * FROM tg_jobs WHERE source_id=$1",
        [source])).rows[0];
      await processJob(client,current,()=>false);
      const state=await pool.query<{history_complete:boolean}>(
        "SELECT history_complete FROM tg_sources WHERE id=$1",[source]);
      if(state.rows[0].history_complete)break;
    }
    const rows=await pool.query<{count:number;history_complete:boolean}>(`
      SELECT count(m.message_id)::integer AS count,s.history_complete
      FROM tg_sources s JOIN tg_messages m ON m.source_id=s.id
      WHERE s.id=$1 GROUP BY s.id`,[source]);
    assert.equal(rows.rows[0].count,100,
      "isolated old evidence must not skip uncollected middle range");
    assert.equal(rows.rows[0].history_complete,true);
  } finally {
    await pool.query("DELETE FROM tg_sources WHERE id=$1",[source]);
  }
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
  let oldUsernameUnavailable = false;
  let usedStablePeer = false;
  let usernameReassigned = false;
  let fallbackPrivate = false;
  let directPrivate = false;
  const client = {
    async getEntity(peer: unknown) {
      if (oldUsernameUnavailable && typeof peer === "string") throw Error("USERNAME_INVALID");
      if (typeof peer !== "string") usedStablePeer = true;
      return {
        className: "Channel", title: "History test channel",
        id: {toString: () => usernameReassigned && typeof peer === "string" ? "999999" : "123456"},
        accessHash:{toString:()=> "987654321"},
        username: (fallbackPrivate && typeof peer !== "string") || (directPrivate && typeof peer === "string") ? undefined
          : usernameReassigned && typeof peer === "string" ? "other_channel" : "history_verified",
      };
    },
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

    // Advance the old-history cursor, then publish two NEW posts before it
    // completes: they must appear immediately without resetting old history.
    await processJob(client, await readJob(), () => false);
    const beforeFresh = await pool.query<{history_complete:boolean;cursor_before_id:string}>(
      "SELECT s.history_complete,j.cursor_before_id::text FROM tg_sources s JOIN tg_jobs j ON j.source_id=s.id WHERE s.id=$1",
      [sourceId]);
    assert.equal(beforeFresh.rows[0].history_complete,false);
    const historyCursor = beforeFresh.rows[0].cursor_before_id;
    // More than two short pages of new messages: the fresh cursor must survive
    // a worker turn without incorrectly advancing last_message_id or old-history cursor.
    const newcomers = Array.from({length:80},(_,i)=>({
      id:730-i,date:postedAt+730-i,message:"Brand new post #"+(730-i),
    }));
    originals.unshift(...newcomers);
    await pool.query("UPDATE tg_sources SET live_checked_at=now()-interval '1 minute' WHERE id=$1",[sourceId]);
    await processJob(client, await readJob(), () => false);
    const midFresh = await pool.query<{
      last_message_id:string;cursor_before_id:string;fresh_cursor_before_id:string;
    }>(`SELECT s.last_message_id::text,j.cursor_before_id::text,j.fresh_cursor_before_id::text
      FROM tg_sources s JOIN tg_jobs j ON j.source_id=s.id WHERE s.id=$1`,[sourceId]);
    assert.equal(midFresh.rows[0].last_message_id,"650",
      "newest watermark must not skip an unfinished fresh interval");
    assert.equal(midFresh.rows[0].cursor_before_id,historyCursor,
      "historical cursor must remain unchanged while fresh catch-up is incomplete");
    assert.equal(midFresh.rows[0].fresh_cursor_before_id,"661",
      "newest-to-oldest cursor must persist across worker turns");
    await processJob(client, await readJob(), () => false);
    const fresh = await pool.query<{count:number}>(
      "SELECT count(*)::integer AS count FROM tg_messages WHERE source_id=$1 AND message_id BETWEEN 651 AND 730",[sourceId]);
    assert.equal(fresh.rows[0].count,80, "all fresh posts must be ingested during historical backfill");
    const afterFresh = await pool.query<{
      last_message_id:string;history_complete:boolean;cursor_before_id:string;fresh_cursor_before_id:string|null;
    }>(`SELECT s.last_message_id::text,s.history_complete,j.cursor_before_id::text,
      j.fresh_cursor_before_id::text FROM tg_sources s JOIN tg_jobs j ON j.source_id=s.id WHERE s.id=$1`,[sourceId]);
    assert.equal(afterFresh.rows[0].last_message_id,"730");
    assert.equal(afterFresh.rows[0].fresh_cursor_before_id,null);
    assert.equal(afterFresh.rows[0].history_complete,false);
    assert.ok(Number(afterFresh.rows[0].cursor_before_id)<Number(historyCursor),
      "historical checkpoint must continue after the fresh catch-up pass");

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
    assert.equal(state.rows[0].count,730);
    assert.equal(state.rows[0].distinct_count,730);
    assert.equal(state.rows[0].history_low_message_id,"1");
    assert.equal(state.rows[0].history_partial,false);
    assert.equal(state.rows[0].history_complete,true);

    // Username can change; a previously saved access hash still resolves the channel.
    oldUsernameUnavailable = true;
    await processJob(client, await readJob(), () => false);
    assert.equal(usedStablePeer,true, "previously resolved channel survives a username rename");
    oldUsernameUnavailable = false;
    usernameReassigned = true;
    usedStablePeer = false;
    await processJob(client, await readJob(), () => false);
    assert.equal(usedStablePeer,true, "a recycled username must be resolved back to the original peer");
    const stablePeer = await pool.query<{peer_id: string;current_username:string}>(
      "SELECT peer_id,current_username FROM tg_sources WHERE id=$1", [sourceId]);
    assert.equal(stablePeer.rows[0]?.peer_id, "123456", "source identity must never switch to recycled username owner");
    assert.equal(stablePeer.rows[0]?.current_username,"history_verified",
      "links should use the currently verified public username");
    fallbackPrivate = true;
    await assert.rejects(processJob(client, await readJob(), () => false), /TG_SOURCE_UNSUPPORTED/,
      "a former public channel must not be followed into a private source");
    fallbackPrivate = false;
    // Even a directly resolved, still-accessible Channel is out of scope if
    // Telegram no longer exposes a verified public handle.
    usernameReassigned = false;
    directPrivate = true;
    await assert.rejects(processJob(client, await readJob(), () => false), /TG_SOURCE_UNSUPPORTED/,
      "a directly resolved private channel must never be ingested");
    directPrivate = false;
    usernameReassigned = true;
    // Without an old access hash, a mismatch must fail closed before ingesting.
    await pool.query("UPDATE tg_sources SET access_hash=NULL WHERE id=$1", [sourceId]);
    await assert.rejects(processJob(client, await readJob(), () => false), /TG_SOURCE_IDENTITY_MISMATCH/);
    const after = await pool.query<{count:number}>(
      "SELECT count(*)::integer AS count FROM tg_messages WHERE source_id=$1", [sourceId]);
    assert.equal(after.rows[0].count,730);
  } finally {
    if (sourceId) await pool.query("DELETE FROM tg_sources WHERE id=$1", [sourceId]);
    await pool.end();
  }
});
