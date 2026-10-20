import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test} from "node:test";

const date = "2026-01-15T12:00:00.000Z";

/** Offline database pressure only: no Telegram session, no paid RPC. */
test("load: simultaneous writes cannot lose daily rollups or duplicate evidence",{
  skip:!process.env.DATABASE_URL,
  timeout:90_000,
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
    await pool.query(`INSERT INTO tg_messages(source_id,message_id,text,posted_at,views)
      SELECT $1,i,'baseline', $2::timestamptz,1
      FROM generate_series(1,1200) i`,[source,date]);
    const bootstrap=await pool.connect();
    try{
      await bootstrap.query("BEGIN");
      await refreshGraphDays(bootstrap,source,["2026-01-15"]);
      await bootstrap.query("COMMIT");
    }catch(error){await bootstrap.query("ROLLBACK");throw error;}
    finally{bootstrap.release();}
    const writers=4;
    const results=await Promise.allSettled(Array.from({length:writers},async(_,i)=>{
      const client=await pool.connect();
      try{
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout='12s'");
        for(let n=0;n<4;n++){
          await persistMessage(client,source,{
            id:2001+i*4+n,date:Math.floor(new Date(date).getTime()/1000),
            message:"Parallel "+i+" "+n,views:10,
          });
        }
        await refreshGraphDays(client,source,["2026-01-15"]);
        await client.query("COMMIT");
      }catch(error){await client.query("ROLLBACK");throw error;}
      finally{client.release();}
    }));
    assert.ok(results.every(r=>r.status==="fulfilled"),
      "parallel source writers must not deadlock or collide: "+
       results.filter(r=>r.status==="rejected").map(r=>String((r as PromiseRejectedResult).reason)).join("; "));
    const actual=(await pool.query<{posts:number;views:string}>(`
      SELECT posts_count AS posts,views_total::text AS views
      FROM tg_source_daily_metrics WHERE source_id=$1 AND day='2026-01-15'`,[source])).rows[0];
    assert.equal(actual.posts,1200+writers*4);
    assert.equal(actual.views,String(1200+writers*4*10));
    const rows=(await pool.query<{n:number}>(`
      SELECT count(*)::int AS n FROM tg_messages WHERE source_id=$1`,[source])).rows[0];
    assert.equal(rows.n,1200+writers*4);

    // Updates do NOT lock the per-source INSERT counter. Deliberately hold
    // four independent transactions open after modifying different rows,
    // then race their destructive DELETE+INSERT daily refresh.
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
    assert.ok(revisions.every(r=>r.status==="fulfilled"),
      "parallel edits must not corrupt daily aggregates: "+
        revisions.filter(r=>r.status==="rejected").map(r=>String((r as PromiseRejectedResult).reason)).join("; "));
    const afterEdit=(await pool.query<{posts:number;views:string}>(`
      SELECT posts_count AS posts,views_total::text AS views
      FROM tg_source_daily_metrics WHERE source_id=$1 AND day='2026-01-15'`,
      [source])).rows[0];
    assert.equal(afterEdit.posts,1200+writers*4);
    assert.equal(afterEdit.views,String(1200+writers*4*10+4*29));
  }finally{
    await pool.query("DELETE FROM tg_sources WHERE id=$1",[source]);
  }
});
