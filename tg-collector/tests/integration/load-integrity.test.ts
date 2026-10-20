import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test} from "node:test";

const date = "2026-01-15T12:00:00.000Z";

/** Offline database pressure only: no Telegram session, no paid RPC. */
test("load: simultaneous writes cannot lose daily rollups or duplicate evidence",{
  skip:!process.env.DATABASE_URL,
  timeout:150_000,
},async()=>{
  const {pool,migrate}=await import("../../src/db.js");
  const {persistMessage}=await import("../../src/persistence/messages.js");
  const {refreshGraphDays}=await import("../../src/analytics/rollups.js");
  await migrate();
  const suffix=randomUUID().replaceAll("-","").slice(0,12);
  const source=(await pool.query<{id:string}>(
    "INSERT INTO tg_sources(identifier,peer_id) VALUES($1,$2) RETURNING id::text",
    ["pressure_"+suffix,"89"+Date.now().toString().slice(-12)])).rows[0].id;
  try {
    const baselineStarted=Date.now();
    await pool.query(`INSERT INTO tg_messages(source_id,message_id,text,posted_at,views)
      SELECT $1,i,'baseline', $2::timestamptz,1
      FROM generate_series(1,10000) i`,[source,date]);
    const bootstrap=await pool.connect();
    try{
      await bootstrap.query("BEGIN");
      await refreshGraphDays(bootstrap,source,["2026-01-15"]);
      await bootstrap.query("COMMIT");
    }catch(error){await bootstrap.query("ROLLBACK");throw error;}
    finally{bootstrap.release();}
    const baselineMs=Date.now()-baselineStarted;
    const writers=4;
    const writesStarted=Date.now();
    const results=await Promise.allSettled(Array.from({length:writers},async(_,i)=>{
      const client=await pool.connect();
      try{
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout='12s'");
        for(let n=0;n<4;n++){
          await persistMessage(client,source,{
            id:20001+i*4+n,date:Math.floor(new Date(date).getTime()/1000),
            message:"Parallel "+i+" "+n,views:10,
          });
        }
        await refreshGraphDays(client,source,["2026-01-15"]);
        await client.query("COMMIT");
      }catch(error){await client.query("ROLLBACK");throw error;}
      finally{client.release();}
    }));
    const parallelWritesMs=Date.now()-writesStarted;
    assert.ok(results.every(r=>r.status==="fulfilled"),
      "parallel source writers must not deadlock or collide: "+
       results.filter(r=>r.status==="rejected").map(r=>String((r as PromiseRejectedResult).reason)).join("; "));
    const actual=(await pool.query<{posts:number;views:string}>(`
      SELECT posts_count AS posts,views_total::text AS views
      FROM tg_source_daily_metrics WHERE source_id=$1 AND day='2026-01-15'`,[source])).rows[0];
    assert.equal(actual.posts,10000+writers*4);
    assert.equal(actual.views,String(10000+writers*4*10));
    const rows=(await pool.query<{n:number}>(`
      SELECT count(*)::int AS n FROM tg_messages WHERE source_id=$1`,[source])).rows[0];
    assert.equal(rows.n,10000+writers*4);

    // Updates do NOT lock the per-source INSERT counter. Deliberately hold
    // four independent transactions open after modifying different rows,
    // then race their destructive DELETE+INSERT daily refresh.
    const editsStarted=Date.now();
    let ready=0;
    let release!:()=>void;
    const barrier=new Promise<void>(resolve=>{release=resolve;});
    const revisions=await Promise.allSettled(Array.from({length:4},async(_,i)=>{
      const tx=await pool.connect();
      try {
        await tx.query("BEGIN");
        await tx.query("SET LOCAL lock_timeout='8s'");
        await persistMessage(tx,source,{
          id:1101+i,date:Math.floor(new Date(date).getTime()/1000),
          message:"Concurrent edit "+i,views:30,
        });
        if(++ready===4)release();
        await barrier;
        await refreshGraphDays(tx,source,["2026-01-15"]);
        await tx.query("COMMIT");
      }catch(error){await tx.query("ROLLBACK");throw error;}
      finally{tx.release();}
    }));
    const parallelEditsMs=Date.now()-editsStarted;
    assert.ok(revisions.every(r=>r.status==="fulfilled"),
      "parallel edits must not corrupt daily aggregates: "+
        revisions.filter(r=>r.status==="rejected").map(r=>String((r as PromiseRejectedResult).reason)).join("; "));
    const afterEdit=(await pool.query<{posts:number;views:string}>(`
      SELECT posts_count AS posts,views_total::text AS views
      FROM tg_source_daily_metrics WHERE source_id=$1 AND day='2026-01-15'`,
      [source])).rows[0];
    assert.equal(afterEdit.posts,10000+writers*4);
    assert.equal(afterEdit.views,String(10000+writers*4*10+4*29));
    console.log(JSON.stringify({stress:"postgres-ingestion",baselinePosts:10000,
      parallelWriters:writers,parallelNewMessages:16,parallelEdits:4,
      baselineMs,parallelWritesMs,parallelEditsMs,finalMessages:afterEdit.posts}));
  }finally{
    await pool.query("DELETE FROM tg_sources WHERE id=$1",[source]);
  }
});


test("load: SKIP LOCKED distributes 24 runnable source jobs without double claims",{
  skip:!process.env.DATABASE_URL,
  timeout:40_000,
},async()=>{
  const {pool,migrate}=await import("../../src/db.js");
  const {claim}=await import("../../src/queue/jobs.js");
  await migrate();
  const suffix=randomUUID().replaceAll("-","").slice(0,12);
  const prior=(await pool.query<{
    collection_enabled:boolean;block_reason:string|null;pause_until:Date|null;
  }>("SELECT collection_enabled,block_reason,pause_until FROM tg_runtime WHERE id=1")).rows[0];
  const sources:string[]=[];
  try {
    await pool.query(`UPDATE tg_runtime
      SET collection_enabled=TRUE,block_reason=NULL,pause_until=NULL WHERE id=1`);
    const list=await pool.query<{id:string}>(`INSERT INTO tg_sources(identifier)
      SELECT $1||'_'||n FROM generate_series(1,24) n RETURNING id::text`,
      ["queue_pressure_"+suffix]);
    sources.push(...list.rows.map(x=>x.id));
    await pool.query(`INSERT INTO tg_jobs(source_id,run_at)
      SELECT id,'2000-01-01'::timestamptz FROM tg_sources WHERE id=ANY($1::bigint[])`,
      [sources]);
    const started=Date.now();
    const jobs=await Promise.all(Array.from({length:24},()=>claim()));
    const elapsed=Date.now()-started;
    assert.equal(jobs.filter(Boolean).length,24,"all 24 jobs should be claimed");
    const ids=jobs.map(x=>x?.id);
    assert.equal(new Set(ids).size,24,"SKIP LOCKED cannot issue same job twice");
    assert.deepEqual(new Set(jobs.map(x=>x?.source_id)),new Set(sources));
    const states=await pool.query<{running:number}>(`
      SELECT count(*)::int AS running FROM tg_jobs
      WHERE source_id=ANY($1::bigint[]) AND state='running'`,[sources]);
    assert.equal(states.rows[0].running,24);
    console.log(JSON.stringify({stress:"parallel-queue-claim",jobs:24,claims:24,elapsedMs:elapsed}));
  }finally{
    if(sources.length)await pool.query("DELETE FROM tg_sources WHERE id=ANY($1::bigint[])",[sources]);
    await pool.query(`UPDATE tg_runtime SET collection_enabled=$1,block_reason=$2,pause_until=$3
      WHERE id=1`,[prior.collection_enabled,prior.block_reason,prior.pause_until]);
  }
});
