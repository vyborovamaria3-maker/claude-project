import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {test} from "node:test";
import type {TelegramClient} from "telegram";

test("ambiguous ticker history is retracted; mint+cashtag counts once", {
  skip: !process.env.DATABASE_URL,
}, async()=>{
  const {pool,migrate}=await import("../../src/db.js");
  const {retractAmbiguousTickerMentions}=await import("../../src/analytics/ticker-reconcile.js");
  const {refreshTokenChannelMetrics,refreshTokenVelocity}=await import("../../src/analytics/token-intelligence.js");
  await migrate();
  const suffix=randomUUID().replaceAll("-","").slice(0,10);
  const ticker="Z"+suffix.slice(0,8).toUpperCase();
  const a="mint_a_"+suffix,b="mint_b_"+suffix,chain="solana-mainnet";
  const source=(await pool.query<{id:string}>(
    "INSERT INTO tg_sources(identifier) VALUES($1) RETURNING id::text",["audit_"+suffix])).rows[0].id;
  const day=new Date().toISOString().slice(0,10);
  try {
    const tx=await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query(`INSERT INTO tg_tokens(chain_id,mint,decimals,metadata_status,mint_layout_verified_at)
        VALUES($1,$2,9,'partial',now()),($1,$3,9,'partial',now())`,[chain,a,b]);
      await tx.query(`INSERT INTO tg_ticker_registry(ticker,chain_id,mint,resolution_status,confidence)
        VALUES($1,$2,$3,'confirmed',1),($1,$2,$4,'confirmed',1)`,[ticker,chain,a,b]);
      await tx.query(`INSERT INTO tg_messages(source_id,message_id,text,posted_at)
        VALUES($1,901,'cashtag only',now()),($1,902,'explicit mint + cashtag',now())`,[source]);
      await tx.query(`INSERT INTO tg_ticker_mentions
        (source_id,message_id,chain_id,ticker,raw_text,analysis_version,message_date)
        VALUES($1,901,$2,$3,$3,4,now()),($1,902,$2,$3,$3,4,now())`,
        [source,chain,ticker]);
      await tx.query(`INSERT INTO tg_token_candidates(source_id,message_id,chain_id,
        candidate_type,candidate_key,raw_value,analysis_version)
        VALUES($1,902,$2,'address',$3,$3,4)`,[source,chain,a]);
      await tx.query(`INSERT INTO tg_token_mentions(source_id,message_id,chain_id,mint,
        mention_type,resolution_status,confidence,message_date,analysis_version)
        VALUES($1,901,$2,$3,'ticker','confirmed',1,now(),4),
          ($1,902,$2,$3,'ticker','confirmed',1,now(),4),
          ($1,902,$2,$3,'mint','confirmed',1,now(),4)`,[source,chain,a]);
      const withdrawn=await retractAmbiguousTickerMentions(tx);
      assert.deepEqual(withdrawn.rows.map(row=>String(row.mint)),[a]);
      const mentions=await tx.query<{message_id:string;mention_type:string;orphaned:boolean}>(`
        SELECT message_id::text,mention_type,orphaned FROM tg_token_mentions
        WHERE source_id=$1 ORDER BY message_id,mention_type`,[source]);
      assert.deepEqual(mentions.rows.map(row=>[row.message_id,row.mention_type,row.orphaned]),
        [["901","ticker",true],["902","mint",false],["902","ticker",false]]);
      await refreshTokenChannelMetrics(tx,source,[day]);
      const daily=await tx.query<{confirmed_token_mentions:number}>(`
        SELECT confirmed_token_mentions FROM tg_channel_metrics_daily
        WHERE source_id=$1 AND day=$2 AND analysis_version=4`,[source,day]);
      assert.equal(daily.rows[0].confirmed_token_mentions,1);
      await refreshTokenVelocity(tx);
      const velocity=await tx.query<{mentions:number}>(`
        SELECT mentions FROM tg_token_velocity WHERE chain_id=$1 AND mint=$2
          AND window_name='5m' ORDER BY window_start DESC LIMIT 1`,[chain,a]);
      assert.equal(velocity.rows[0].mentions,1);
      await tx.query("COMMIT");
    } catch(error){await tx.query("ROLLBACK");throw error;}
    finally{tx.release();}
  } finally {
    await pool.query("DELETE FROM tg_sources WHERE id=$1",[source]);
    await pool.query("DELETE FROM tg_tokens WHERE chain_id=$1 AND mint=ANY($2::text[])",[chain,[a,b]]);
  }
});

test("engagement snapshot refreshes the daily views aggregate",{
  skip: !process.env.DATABASE_URL,
},async()=>{
  const {pool,migrate}=await import("../../src/db.js");
  const {processJob}=await import("../../src/engines/channel.js");
  await migrate();
  const suffix=randomUUID().replaceAll("-","").slice(0,10);
  const identifier="snapshot_"+suffix,peer="79"+Date.now().toString().slice(-10);
  const source=(await pool.query<{id:string}>(`
    INSERT INTO tg_sources(identifier,peer_id,current_username,full_history,history_complete,last_message_id)
    VALUES($1,$2,$1,TRUE,TRUE,10) RETURNING id::text`,[identifier,peer])).rows[0].id;
  try {
    await pool.query(`INSERT INTO tg_messages(source_id,message_id,text,posted_at,views)
      VALUES($1,10,'snapshot',now(),1)`,[source]);
    const job=(await pool.query(`INSERT INTO tg_jobs(source_id) VALUES($1) RETURNING *`,[source])).rows[0];
    const client={
      async getEntity(){return {className:"Channel",id:{toString:()=>peer},
        username:identifier,title:"Views",accessHash:{toString:()=> "1"}};},
      async getMessages(){return [{id:10,message:"snapshot",views:125,date:Math.floor(Date.now()/1000)}];},
    } as unknown as TelegramClient;
    await processJob(client,job,()=>false);
    const day=new Date().toISOString().slice(0,10);
    const daily=(await pool.query<{views_total:string}>(`
      SELECT views_total::text FROM tg_source_daily_metrics
      WHERE source_id=$1 AND day=$2`,[source,day])).rows[0];
    assert.equal(daily.views_total,"125");
  } finally {
    await pool.query("DELETE FROM tg_sources WHERE id=$1",[source]);
  }
});

test("RPC candidate promotion ignores soft-deleted message observations",{
  skip: !process.env.DATABASE_URL,
},async()=>{
  const {pool,migrate}=await import("../../src/db.js");
  const {activeMintOccurrences}=await import("../../src/analytics/token-candidate-occurrences.js");
  await migrate();
  const suffix=randomUUID().replaceAll("-","").slice(0,12);
  const mint="mint_"+suffix;
  const source=(await pool.query<{id:string}>(
    "INSERT INTO tg_sources(identifier) VALUES($1) RETURNING id::text",
    ["dead_mint_"+suffix])).rows[0].id;
  try {
    await pool.query(`INSERT INTO tg_messages(source_id,message_id,text,posted_at,deleted_at)
      VALUES($1,911,'live',now(),NULL),($1,912,'deleted',now(),now())`,[source]);
    await pool.query(`INSERT INTO tg_token_candidates(
      source_id,message_id,chain_id,candidate_type,candidate_key,raw_value,analysis_version)
      VALUES($1,911,'solana-mainnet','address',$2,$2,4),
        ($1,912,'solana-mainnet','address',$2,$2,4)`,[source,mint]);
    const tx=await pool.connect();
    try {
      const rows=await activeMintOccurrences(tx,mint);
      assert.deepEqual(rows.rows.map(row=>row.message_id),["911"],
        "the deleted message must not be resurrected as an active token mention");
    } finally {tx.release();}
  } finally {
    await pool.query("DELETE FROM tg_sources WHERE id=$1",[source]);
  }
});

test("restoring a deleted message never reactivates a pre-strict mint",{
  skip: !process.env.DATABASE_URL,
},async()=>{
  const {pool,migrate}=await import("../../src/db.js");
  await migrate();
  const suffix=randomUUID().replaceAll("-","").slice(0,13);
  const mint="legacy_"+suffix,chain="solana-mainnet";
  const source=(await pool.query<{id:string}>(
    "INSERT INTO tg_sources(identifier) VALUES($1) RETURNING id::text",
    ["untrusted_"+suffix])).rows[0].id;
  try {
    await pool.query(`INSERT INTO tg_tokens(chain_id,mint,decimals,metadata_status)
      VALUES($1,$2,9,'verified')`,[chain,mint]);
    await pool.query(`INSERT INTO tg_messages(source_id,message_id,text,posted_at,deleted_at)
      VALUES($1,912,'legacy candidate',now(),now())`,[source]);
    await pool.query(`INSERT INTO tg_token_mentions(source_id,message_id,chain_id,mint,
      mention_type,resolution_status,confidence,message_date,analysis_version,orphaned)
      VALUES($1,912,$2,$3,'mint','confirmed',1,now(),4,TRUE)`,[source,chain,mint]);
    await pool.query(`UPDATE tg_messages SET deleted_at=NULL
      WHERE source_id=$1 AND message_id=912`,[source]);
    const result=(await pool.query<{orphaned:boolean}>(`
      SELECT orphaned FROM tg_token_mentions WHERE source_id=$1 AND message_id=912`,
      [source])).rows[0];
    assert.equal(result.orphaned,true,"legacy unverified token remains unconfirmed");
    const first=(await pool.query<{n:number}>(`SELECT count(*)::integer AS n
      FROM tg_token_first_mentions WHERE chain_id=$1 AND mint=$2`,[chain,mint])).rows[0];
    assert.equal(first.n,0);
  } finally {
    await pool.query("DELETE FROM tg_sources WHERE id=$1",[source]);
    await pool.query("DELETE FROM tg_tokens WHERE chain_id=$1 AND mint=$2",[chain,mint]);
  }
});
