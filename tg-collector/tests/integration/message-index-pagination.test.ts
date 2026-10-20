import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test} from "node:test";

test("keyword index advances past 1000 false substring matches to older true matches",{
  skip: !process.env.DATABASE_URL,
},async()=>{
  const {pool,migrate}=await import("../../src/db.js");
  const {indexKnownMentions}=await import("../../src/runtime/message-index.js");
  await migrate();
  const prev=(await pool.query<{
    enabled:boolean;message_search_enabled:boolean;message_terms:string[];
  }>("SELECT enabled,message_search_enabled,message_terms FROM tg_discovery_settings WHERE id=1")).rows[0];
  const runtime=(await pool.query<{
    collection_enabled:boolean;block_reason:string|null;pause_until:Date|null;
  }>("SELECT collection_enabled,block_reason,pause_until FROM tg_runtime WHERE id=1")).rows[0];
  const previous=(await pool.query<{
    term_signature:string;sort_date:Date|null;sort_source_id:string|null;sort_message_id:string|null;
  }>("SELECT term_signature,sort_date,sort_source_id::text,sort_message_id::text FROM tg_message_index_progress WHERE id=1")).rows[0];
  const identifier="index_"+randomUUID().replaceAll("-","").slice(0,11);
  const peer="77"+Math.floor(Math.random()*1e12).toString().padStart(12,"0");
  const source=(await pool.query<{id:string}>(`
    INSERT INTO tg_sources(identifier,peer_id) VALUES($1,$2) RETURNING id::text`,
    [identifier,peer])).rows[0].id;
  try {
    await pool.query(`INSERT INTO tg_messages(source_id,message_id,text,posted_at)
      SELECT $1,n,CASE WHEN n=1 THEN 'PNUT rally' ELSE 'PNUTxyz' END,
        now()-(1002-n)*interval '1 second'
      FROM generate_series(1,1001) AS n`,[source]);
    await pool.query(`UPDATE tg_discovery_settings
      SET enabled=TRUE,message_search_enabled=TRUE,message_terms=ARRAY['PNUT'] WHERE id=1`);
    await pool.query(`UPDATE tg_runtime
      SET collection_enabled=TRUE,block_reason=NULL,pause_until=NULL WHERE id=1`);
    await indexKnownMentions();
    let count=(await pool.query<{n:number}>(`SELECT count(*)::integer AS n
      FROM tg_discovery_mentions WHERE peer_id=$1`,[peer])).rows[0].n;
    assert.equal(count,0,"exact term matching must reject PNUTxyz");
    await indexKnownMentions();
    count=(await pool.query<{n:number}>(`SELECT count(*)::integer AS n
      FROM tg_discovery_mentions WHERE peer_id=$1 AND message_id=1`,[peer])).rows[0].n;
    assert.equal(count,1,"older real PNUT mention must not be starved");
  } finally {
    await pool.query("DELETE FROM tg_sources WHERE id=$1",[source]);
    await pool.query("DELETE FROM tg_discovery_mentions WHERE peer_id=$1",[peer]);
    await pool.query(`UPDATE tg_message_index_progress SET term_signature=$1,sort_date=$2,
      sort_source_id=$3,sort_message_id=$4 WHERE id=1`,
      [previous.term_signature,previous.sort_date,previous.sort_source_id,previous.sort_message_id]);
    await pool.query(`UPDATE tg_discovery_settings
      SET enabled=$1,message_search_enabled=$2,message_terms=$3 WHERE id=1`,
      [prev.enabled,prev.message_search_enabled,prev.message_terms]);
    await pool.query(`UPDATE tg_runtime
      SET collection_enabled=$1,block_reason=$2,pause_until=$3 WHERE id=1`,
      [runtime.collection_enabled,runtime.block_reason,runtime.pause_until]);
  }
});
