import "dotenv/config";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test} from "node:test";

const stamp=Math.floor(new Date("2026-01-15T12:00:00Z").getTime()/1000);

test("resilience: four concurrent migration entrypoints preserve a single checksum ledger",{
  skip:!process.env.DATABASE_URL,
  timeout:40_000,
},async()=>{
  const {pool,migrate}=await import("../../src/db.js");
  const started=Date.now();
  await Promise.all(Array.from({length:4},()=>migrate()));
  const rows=(await pool.query<{name:string;checksum:string}>(`
    SELECT name,checksum FROM schema_migrations WHERE name LIKE '03%'
    ORDER BY name`)).rows;
  assert.deepEqual(rows.map(x=>x.name),[
    "030_discovery_identity_reconciliation.sql",
    "031_verified_history_pass.sql",
    "032_unique_current_public_username.sql",
    "033_message_index_progress.sql",
    "034_mint_layout_attestation.sql",
    "035_unattested_mint_lifecycle.sql",
  ]);
  assert.ok(rows.every(x=>/^[0-9a-f]{64}$/.test(x.checksum.trim())));
  assert.equal(new Set(rows.map(x=>x.name)).size,rows.length);
  console.log(JSON.stringify({stress:"migrate-parallel",clients:4,elapsedMs:Date.now()-started}));
});

test("resilience: injected mid-transaction failure rolls back messages, links, metrics and counters",{
  skip:!process.env.DATABASE_URL,
  timeout:40_000,
},async()=>{
  const {pool,migrate}=await import("../../src/db.js");
  const {persistMessage}=await import("../../src/persistence/messages.js");
  const {refreshGraphDays}=await import("../../src/analytics/rollups.js");
  await migrate();
  const identifier="rollback_"+randomUUID().replaceAll("-","").slice(0,13);
  const source=(await pool.query<{id:string}>(`
    INSERT INTO tg_sources(identifier) VALUES($1) RETURNING id::text`,[identifier])).rows[0].id;
  try {
    const tx=await pool.connect();
    try {
      await tx.query("BEGIN");
      for(let n=1;n<=20;n++)
        await persistMessage(tx,source,{id:n,message:"Reference @ExampleChannel",date:stamp});
      await refreshGraphDays(tx,source,["2026-01-15"]);
      // Simulates process/page error before transaction commit.
      throw Error("FAULT_INJECTION_BEFORE_COMMIT");
    }catch(error){
      await tx.query("ROLLBACK");
      assert.match(String(error),/FAULT_INJECTION_BEFORE_COMMIT/);
    }finally{tx.release();}
    for(const table of ["tg_messages","tg_message_links","tg_source_daily_metrics","tg_graph_daily_edges",
      "tg_channel_metrics_daily"]){
      const count=(await pool.query<{n:number}>(`
        SELECT count(*)::integer AS n FROM ${table} WHERE source_id=$1`,[source])).rows[0].n;
      assert.equal(count,0,table+" survived rollback");
    }
    const counter=(await pool.query<{n:number}>(`
      SELECT coalesce(sum(message_count),0)::integer AS n
      FROM tg_source_message_counters WHERE source_id=$1`,[source])).rows[0].n;
    assert.equal(counter,0,"insert trigger counters must roll back with message");
  }finally{await pool.query("DELETE FROM tg_sources WHERE id=$1",[source]);}
});

test("resilience: 50 identical message revisions remain idempotent, final views win",{
  skip:!process.env.DATABASE_URL,
  timeout:40_000,
},async()=>{
  const {pool,migrate}=await import("../../src/db.js");
  const {persistMessage}=await import("../../src/persistence/messages.js");
  const {refreshGraphDays}=await import("../../src/analytics/rollups.js");
  await migrate();
  const source=(await pool.query<{id:string}>(`
    INSERT INTO tg_sources(identifier) VALUES($1) RETURNING id::text`,
    ["replay_"+randomUUID().replaceAll("-","").slice(0,12)])).rows[0].id;
  try {
    const tx=await pool.connect();
    try {
      await tx.query("BEGIN");
      for(let n=1;n<=50;n++){
        await persistMessage(tx,source,{id:501,message:"@ExampleChannel update",
          date:stamp,views:n});
      }
      await refreshGraphDays(tx,source,["2026-01-15"]);
      await tx.query("COMMIT");
    }catch(error){await tx.query("ROLLBACK");throw error;}finally{tx.release();}
    const actual=(await pool.query<{msgs:number;links:number;views:string;counter:string}>(`
      SELECT (SELECT count(*)::integer FROM tg_messages WHERE source_id=$1) AS msgs,
       (SELECT count(*)::integer FROM tg_message_links WHERE source_id=$1) AS links,
       (SELECT views_total::text FROM tg_source_daily_metrics
         WHERE source_id=$1 AND day='2026-01-15') AS views,
       (SELECT message_count::text FROM tg_source_message_counters WHERE source_id=$1) AS counter`,
       [source])).rows[0];
    assert.deepEqual(actual,{msgs:1,links:1,views:"50",counter:"1"});
  }finally{await pool.query("DELETE FROM tg_sources WHERE id=$1",[source]);}
});

test("resilience: 12,000 posts across six channels are isolated under concurrent graph refresh",{
  skip:!process.env.DATABASE_URL,
  timeout:90_000,
},async()=>{
  const {pool,migrate}=await import("../../src/db.js");
  const {refreshGraphDays}=await import("../../src/analytics/rollups.js");
  await migrate();
  const suffix=randomUUID().replaceAll("-","").slice(0,12);
  const sources=(await pool.query<{id:string}>(`
    INSERT INTO tg_sources(identifier)
    SELECT $1||'_'||x::text FROM generate_series(1,6) x RETURNING id::text`,
    ["multisource_"+suffix])).rows.map(x=>x.id);
  try {
    const start=Date.now();
    await pool.query(`INSERT INTO tg_messages(source_id,message_id,text,posted_at,views)
      SELECT s.id,n,'multi-source',DATE '2026-01-15'+((n%2)::integer),
        s.rank::integer
      FROM unnest($1::bigint[]) WITH ORDINALITY s(id,rank)
      CROSS JOIN generate_series(1,2000) n`,[sources]);
    const results=await Promise.allSettled(sources.map(async id=>{
      const client=await pool.connect();
      try{
        await client.query("BEGIN");
        await refreshGraphDays(client,id,["2026-01-15","2026-01-16"]);
        await client.query("COMMIT");
      }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
    }));
    assert.ok(results.every(x=>x.status==="fulfilled"),
      "cross-source concurrent refresh failed: "+
      results.filter(x=>x.status==="rejected").map(x=>String((x as PromiseRejectedResult).reason)).join("; "));
    const rollups=(await pool.query<{
      source_id:string;day:string;posts_count:number;views_total:string
    }>(`SELECT source_id::text,day::text,posts_count,views_total::text
      FROM tg_source_daily_metrics WHERE source_id=ANY($1::bigint[])
      ORDER BY source_id,day`,[sources])).rows;
    assert.equal(rollups.length,12);
    for(const id of sources){
      const found=rollups.filter(x=>x.source_id===id);
      assert.equal(found.length,2);
      const number=sources.indexOf(id)+1;
      for(const day of found){
        assert.equal(day.posts_count,1000);
        assert.equal(day.views_total,String(1000*number));
      }
    }
    const total=(await pool.query<{n:number}>(`
      SELECT count(*)::integer AS n FROM tg_messages WHERE source_id=ANY($1::bigint[])`,
      [sources])).rows[0].n;
    assert.equal(total,12000);
    console.log(JSON.stringify({stress:"six-source-refresh",messages:12000,
      channels:6,concurrentRefreshes:6,elapsedMs:Date.now()-start}));
  }finally{await pool.query("DELETE FROM tg_sources WHERE id=ANY($1::bigint[])",[sources]);}
});
