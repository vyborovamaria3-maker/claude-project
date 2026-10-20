import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

test("a recycled username cannot redirect public discovery evidence to the previous peer", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const {pool,migrate} = await import("../../src/db.js");
  const {addCandidate} = await import("../../src/runtime/discovery.js");
  await migrate();
  const suffix = randomUUID().replaceAll("-","").slice(0,12);
  const handle="recycled_"+suffix;
  const peerA=String(Date.now())+"100";
  const peerB=String(Date.now())+"200";
  const status = await pool.query<{enabled:boolean;revision:number}>(
    "SELECT enabled,revision FROM tg_discovery_settings WHERE id=1");
  const runtime = await pool.query<{collection_enabled:boolean}>(
    "SELECT collection_enabled FROM tg_runtime WHERE id=1");
  let sourceId: string | null = null;
  let newSourceId: string | null = null;
  try {
    const source=await pool.query<{id:string}>(`
      INSERT INTO tg_sources(identifier,peer_id,current_username)
      VALUES($1,$2,$3) RETURNING id::text`,[handle,peerA,"new_"+suffix]);
    sourceId=source.rows[0].id;
    await pool.query("UPDATE tg_discovery_settings SET enabled=TRUE WHERE id=1");
    await pool.query("UPDATE tg_runtime SET collection_enabled=TRUE,block_reason=NULL,pause_until=NULL WHERE id=1");
    // Simulate an old discovery association made by username, not verified ID.
    await pool.query(`INSERT INTO tg_discovered_sources
      (peer_id,username,title,keyword,source_id,connected_at)
      VALUES($1,$2,'Wrong alias owner','memecoin',$3,now())`,
      [peerB,handle,sourceId]);
    await pool.query(`INSERT INTO tg_discovery_mentions
      (peer_id,message_id,username,title,text,matched_terms,source_id)
      VALUES($1,43,$2,'Stale','historical hit',ARRAY['memecoin'],$3)`,
      [peerB,handle,sourceId]);
    await addCandidate({peer:peerB,username:handle,title:"Unrelated public channel"},
      "memecoin",status.rows[0].revision,{id:42,message:"@CryptoTest",date:1792065600});
    const messages=await pool.query<{count:number}>(`
      SELECT count(*)::integer AS count FROM tg_messages WHERE source_id=$1`,[sourceId]);
    assert.equal(messages.rows[0].count,0,"unrelated channel's post may not enter previous source");
    const newSource=await pool.query<{id:string;identifier:string;current_username:string;full_history:boolean}>(`
      SELECT id::text,identifier,current_username,full_history FROM tg_sources WHERE peer_id=$1`,[peerB]);
    assert.equal(newSource.rows.length,1,"discovered peer must be tracked despite recycled handle");
    newSourceId=newSource.rows[0].id;
    assert.equal(newSource.rows[0].identifier,"peer_"+peerB);
    assert.equal(newSource.rows[0].current_username,handle);
    assert.equal(newSource.rows[0].full_history,false,"keyword discovery must remain opt-in");
    const evidence=await pool.query<{message_id:string;source_id:string|null}>(`
      SELECT message_id::text,source_id::text FROM tg_discovery_mentions
      WHERE peer_id=$1 ORDER BY message_id`,[peerB]);
    assert.deepEqual(evidence.rows.map(row=>[row.message_id,row.source_id]),
      [["42",newSourceId],["43",null]],
      "only verified peer evidence may attach to a source");
    const oldSource=await pool.query<{count:number}>(`
      SELECT count(*)::integer AS count FROM tg_sources WHERE identifier=$1`,[handle]);
    assert.equal(oldSource.rows[0].count,1,"old owner must retain its original archive");
    await assert.rejects(pool.query("INSERT INTO tg_sources(identifier,peer_id) VALUES($1,$2)",
      ["duplicate_"+suffix,peerA]),(error:unknown)=>
      (error as {code?:string}).code==="23505","duplicate verified channel ID must be rejected");
  } finally {
    await pool.query("DELETE FROM tg_discovery_mentions WHERE peer_id=$1",[peerB]);
    await pool.query("DELETE FROM tg_discovered_sources WHERE peer_id=$1",[peerB]);
    if(newSourceId)await pool.query("DELETE FROM tg_sources WHERE id=$1",[newSourceId]);
    if(sourceId)await pool.query("DELETE FROM tg_sources WHERE id=$1",[sourceId]);
    await pool.query("UPDATE tg_discovery_settings SET enabled=$1 WHERE id=1",
      [status.rows[0].enabled]);
    await pool.query("UPDATE tg_runtime SET collection_enabled=$1 WHERE id=1",
      [runtime.rows[0].collection_enabled]);
    // Pool is reused by the next test in this file.
  }
});

test("v4 leaves pending, unverified Solana address records unresolved", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const {pool,migrate} = await import("../../src/db.js");
  const {persistMessage} = await import("../../src/persistence/messages.js");
  await migrate();
  // Token Program is a valid Solana address but not a mint account.
  // The mock pending row must not turn it into a confirmed token.
  const address = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const wasPresent = await pool.query("SELECT 1 FROM tg_tokens WHERE chain_id='solana-mainnet' AND mint=$1", [address]);
  const source = await pool.query<{id:string}>(
    "INSERT INTO tg_sources(identifier) VALUES($1) RETURNING id::text",
    ["pending_mint_" + randomUUID().replaceAll("-","").slice(0,12)]);
  try {
    await pool.query(`INSERT INTO tg_tokens(chain_id,mint,metadata_status)
      VALUES('solana-mainnet',$1,'pending') ON CONFLICT DO NOTHING`, [address]);
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await persistMessage(tx,source.rows[0].id,{
        id:451,message:"Unverified contract " + address,date:1792065600,
      });
      await tx.query("COMMIT");
    } catch(error) {await tx.query("ROLLBACK");throw error;}
    finally {tx.release();}
    const candidate = await pool.query<{resolution_status:string}>(`
      SELECT resolution_status FROM tg_token_candidates
      WHERE source_id=$1 AND message_id=451 AND candidate_key=$2 AND analysis_version=4`,
      [source.rows[0].id,address]);
    assert.equal(candidate.rows[0]?.resolution_status,"unresolved");
    const mentions = await pool.query<{count:number}>(`
      SELECT count(*)::integer AS count FROM tg_token_mentions
      WHERE source_id=$1 AND message_id=451 AND mint=$2 AND analysis_version=4 AND orphaned=FALSE`,
      [source.rows[0].id,address]);
    assert.equal(mentions.rows[0].count,0);
  } finally {
    await pool.query("DELETE FROM tg_sources WHERE id=$1",[source.rows[0].id]);
    if(!wasPresent.rowCount) await pool.query("DELETE FROM tg_tokens WHERE chain_id='solana-mainnet' AND mint=$1",[address]);
  }
});

test("v4 re-analysis reuses an already verified Solana mint, including hidden entities", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const {pool,migrate} = await import("../../src/db.js");
  const {persistMessage} = await import("../../src/persistence/messages.js");
  await migrate();
  const mint="So11111111111111111111111111111111111111112";
  const original=await pool.query("SELECT 1 FROM tg_tokens WHERE chain_id='solana-mainnet' AND mint=$1",[mint]);
  const idSuffix=randomUUID().replaceAll("-","").slice(0,15);
  let sourceId: string|null=null;
  try {
    await pool.query(`INSERT INTO tg_tokens(chain_id,mint,decimals,metadata_status,metadata_provider)
      VALUES('solana-mainnet',$1,9,'verified','offline-test') ON CONFLICT DO NOTHING`,[mint]);
    const source=await pool.query<{id:string}>(`
      INSERT INTO tg_sources(identifier) VALUES($1) RETURNING id::text`,["reused_mint_"+idSuffix]);
    sourceId=source.rows[0].id;
    const tx=await pool.connect();
    try {
      await tx.query("BEGIN");
      await persistMessage(tx,sourceId,{
        id:121,message:"Project token $WRAPPED",
        date:1792065600,
        entities:[{className:"MessageEntityTextUrl",url:"https://solscan.io/token/"+mint}],
      });
      await tx.query("COMMIT");
    } catch(error){await tx.query("ROLLBACK");throw error;} finally{tx.release();}
    const row=await pool.query<{resolution_status:string;analysis_version:number}>(`
      SELECT resolution_status,analysis_version FROM tg_token_candidates
      WHERE source_id=$1 AND message_id=121 AND candidate_key=$2`,[sourceId,mint]);
    assert.equal(row.rows[0]?.resolution_status,"confirmed_token");
    assert.equal(row.rows[0]?.analysis_version,4);
    const mention=await pool.query<{count:number}>(`
      SELECT count(*)::integer AS count FROM tg_token_mentions
      WHERE source_id=$1 AND message_id=121 AND mint=$2 AND analysis_version=4 AND orphaned=FALSE`,[sourceId,mint]);
    assert.ok(mention.rows[0].count>=1);
    const marker=await pool.query<{entities_observed_at:Date|null}>(`
      SELECT entities_observed_at FROM tg_messages WHERE source_id=$1 AND message_id=121`,[sourceId]);
    assert.ok(marker.rows[0].entities_observed_at,"fetched entities must have provenance");
  } finally {
    if(sourceId)await pool.query("DELETE FROM tg_sources WHERE id=$1",[sourceId]);
    if(!original.rowCount)await pool.query("DELETE FROM tg_tokens WHERE chain_id='solana-mainnet' AND mint=$1",[mint]);
    await pool.end();
  }
});
