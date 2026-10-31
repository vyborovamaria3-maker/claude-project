import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {createRequire} from "node:module";
import {readFile} from "node:fs/promises";
import pg from "pg";
import Database from "better-sqlite3";
import {
  buildEntityRef, buildEvidenceRef, buildVerifiedTokenLinkEvent,
  buildTokenLinksInvalidatedEvent, formatAuthorId, formatSourceId, formatTokenId,
} from "@claude-project/contracts";
import {
  POSTGRES_OUTBOX_DDL, SQLITE_OUTBOX_DDL,
  emitPostgres, claimPostgres, ackPostgres, failPostgres,
  emitSqlite, claimSqlite, ackSqlite, failSqlite,
} from "@claude-project/event-outbox";
import {
  runDeliveryBatch, queryActiveTokenLinks, queryActiveBlockchainSwapEvidence,
  queryTokenTimeline,
} from "../dist/index.js";

const require=createRequire(import.meta.url);
const {buildTokenSwapRevisionEvent}=require(
  "../../solana-launcher/scripts/blockchain-token-swap-revisions.cjs");
const url=process.env.INTELLIGENCE_TEST_DB_URL;
const mint="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const token=formatTokenId("solana",mint);
const wallet="1".repeat(32), signature="1".repeat(64);
const occurred="2026-10-20T01:00:00Z";
const xSeen="2026-10-20T01:10:00Z";
const chainSeen="2026-10-20T01:12:00Z";
const tgSeen="2026-10-20T01:13:00Z";
const edited="2026-10-20T01:25:00Z";
const proof=(when)=>({
  chainId:"solana-mainnet", method:"spl_mint_account",
  tokenProgram:"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  provider:"alchemy-solana-rpc", checkedAt:when,
});
const entity=(source,when)=>buildEntityRef({
  kind:source==="x"?"author":"source",
  canonicalId:source==="x"?formatAuthorId("x","9999"):formatSourceId("tg","12345"),
  firstSeenAt:when,lastSeenAt:when,
});
const evidence=(source,when)=>buildEvidenceRef(source==="x"?{
  sourceKind:"x_tweet",tweetId:"101",observedAt:when,occurredAt:occurred,
}:{
  sourceKind:"tg_message",sourceAccountId:"12345",messageId:"201",
  observedAt:when,occurredAt:occurred,
});
function verified(source,when,revision){
  return buildVerifiedTokenLinkEvent({
    sourceSystem:source,sourceEntity:entity(source,when),
    evidenceRef:evidence(source,when),mint,matchedLiteralMint:mint,
    sourceRevisionSha256:revision.repeat(64),mintVerification:proof(when),
  });
}
function invalidated(source,when,reason){
  return buildTokenLinksInvalidatedEvent({
    sourceSystem:source,sourceEntity:entity(source,when),
    evidenceRef:evidence(source,when),
    reason,sourceRevisionSha256:"d".repeat(64),
  });
}
const chainTransaction={
  signature,slot:320000001,timestamp:Date.parse(occurred)/1000,type:"SWAP",
  feePayer:wallet,fee:5000,
  events:{swap:{
    nativeInput:{account:wallet,amount:"1000000000"},
    tokenOutputs:[{userAccount:wallet,mint,rawTokenAmount:{tokenAmount:"1000000",decimals:6}}],
  }},
  accountData:[{account:wallet,nativeBalanceChange:-1000005000,
    tokenBalanceChanges:[{userAccount:wallet,mint,
      rawTokenAmount:{tokenAmount:"1000000",decimals:6}}]}],
};
const revision=(number,hash,when,transaction)=>buildTokenSwapRevisionEvent({
  kind:"wallet",address:wallet,signature,rawRevision:number,
  payloadHash:hash.repeat(64),observedAt:Date.parse(when),transaction,
});
const portPg=pool=>({
  claim:options=>claimPostgres(pool,options),
  ack:event=>ackPostgres(pool,event.id,event.leaseOwner,event.leaseUntil),
  fail:(event,reason,next)=>failPostgres(pool,event.id,event.leaseOwner,event.leaseUntil,reason,next),
});
const portSqlite=db=>({
  claim:async options=>claimSqlite(db,options),
  ack:async event=>ackSqlite(db,event.id,event.leaseOwner,event.leaseUntil),
  fail:async(event,reason,next)=>failSqlite(db,event.id,event.leaseOwner,event.leaseUntil,reason,next),
});
const deliver=(source,destination,id)=>runDeliveryBatch(source,destination,{
  workerId:id,batchSize:1,leaseMs:120000,
});
const count=async(pool,table)=>
  Number((await pool.query("SELECT COUNT(*)::integer AS n FROM "+table)).rows[0].n);
async function commitSource(pool,id,event){
  const tx=await pool.connect();
  try{
    await tx.query("BEGIN");
    await tx.query("INSERT INTO source_observations(record_id) VALUES($1)",[id]);
    await emitPostgres(tx,event);
    await tx.query("COMMIT");
  }catch(error){
    try{await tx.query("ROLLBACK")}catch{/* preserve first error */}
    throw error;
  }finally{tx.release();}
}

test("P0 #173: isolated X/TG PG and chain SQLite outboxes deliver verified source evidence, retract independently and replay after ACK loss",{
  skip:!url,
},async()=>{
  // Fixtures are PREVERIFIED synthetic messages and saved decoded chain receipts:
  // this does not prove a real X/TG mint verifier, RPC call or live source collection.
  const suffix=randomBytes(6).toString("hex");
  const schemas={x:"vlink_x_"+suffix,tg:"vlink_tg_"+suffix,dst:"vlink_dst_"+suffix};
  const admin=new pg.Client({connectionString:url});
  let xPool,tgPool,dst,sqlite;
  await admin.connect();
  try{
    for(const schema of Object.values(schemas))
      await admin.query('CREATE SCHEMA "'+schema+'"');
    for(const source of ["x","tg"]){
      await admin.query('SET search_path TO "'+schemas[source]+'"');
      await admin.query(POSTGRES_OUTBOX_DDL);
      await admin.query("CREATE TABLE source_observations(record_id TEXT PRIMARY KEY)");
    }
    await admin.query('SET search_path TO "'+schemas.dst+'"');
    for(const name of [
      "001_entity_registry.sql","002_timeline.sql",
      "004_token_link_observations.sql","005_blockchain_swap_evidence_revisions.sql",
    ])
      await admin.query(await readFile(new URL("../migrations/"+name,import.meta.url),"utf8"));
    const pool=schema=>new pg.Pool({
      connectionString:url,options:"-c search_path="+schema,max:3,
    });
    xPool=pool(schemas.x);tgPool=pool(schemas.tg);dst=pool(schemas.dst);
    sqlite=new Database(":memory:");
    sqlite.exec(SQLITE_OUTBOX_DDL);
    sqlite.exec("CREATE TABLE source_observations(record_id TEXT PRIMARY KEY)");
    const xEvent=verified("x",xSeen,"a"),tgEvent=verified("tg",tgSeen,"b");
    const chainEvent=revision(1,"c",chainSeen,chainTransaction);
    assert.equal(chainEvent.payload.swapRevision.status,"supported");
    assert.equal(chainEvent.payload.swapRevision.canonicalTokenId,token);
    assert.notEqual(xEvent.payload.registryEvent.evidenceRef.sourceId,
      tgEvent.payload.registryEvent.evidenceRef.sourceId);
    assert.throws(()=>buildVerifiedTokenLinkEvent({
      sourceSystem:"x",sourceEntity:entity("x",xSeen),
      evidenceRef:evidence("x",xSeen),mint,
      matchedLiteralMint:"So11111111111111111111111111111111111111112",
      sourceRevisionSha256:"a".repeat(64),mintVerification:proof(xSeen),
    }),/literal mint/i,"a matching ticker or unrelated mint is not verification");

    // Rollback the SOURCE transaction: no orphan outbox record is allowed.
    const rollback=await xPool.connect();
    try{
      await rollback.query("BEGIN");
      await rollback.query("INSERT INTO source_observations VALUES('rolled-back')");
      await emitPostgres(rollback,verified("x",xSeen,"e"));
      await rollback.query("ROLLBACK");
    }finally{rollback.release();}
    assert.equal(await count(xPool,"source_observations"),0);
    assert.equal(await count(xPool,"outbox_events"),0);
    assert.throws(()=>sqlite.transaction(()=>{
      sqlite.prepare("INSERT INTO source_observations VALUES('rolled-back')").run();
      emitSqlite(sqlite,chainEvent);
      throw new Error("injected_source_rollback");
    })(),/injected_source_rollback/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM outbox_events").get().n,0);

    await commitSource(xPool,"x:tweet:101",xEvent);
    await commitSource(tgPool,"tg:message:12345:201",tgEvent);
    sqlite.transaction(()=>{
      sqlite.prepare("INSERT INTO source_observations VALUES(?)").run("chain:tx:solana:"+signature);
      emitSqlite(sqlite,chainEvent);
    })();
    for(const p of [xPool,tgPool]){
      assert.equal(await count(p,"source_observations"),1);
      assert.equal(await count(p,"outbox_events"),1);
    }
    const ports=[portPg(xPool),portPg(tgPool),portSqlite(sqlite)];

    // Inject a destination COMMIT failure. The transaction is rolled back and
    // the X source is NOT ACKed; later retry is the only permitted progression.
    const refuseCommit={
      connect:async()=>{
        const client=await dst.connect();
        return {
          query:(sql,params)=>sql==="COMMIT"
            ? Promise.reject(new Error("injected_destination_commit_failure"))
            : client.query(sql,params),
          release:()=>client.release(),
        };
      },
    };
    const failed=await deliver(ports[0],refuseCommit,"commit-failure");
    assert.equal(failed.failed,1);
    assert.equal(failed.delivered,0);
    assert.equal(await count(dst,"intelligence_inbox"),0);
    assert.equal(Number((await xPool.query(
      "SELECT COUNT(*)::integer AS n FROM outbox_events WHERE processed_at IS NOT NULL"
    )).rows[0].n),0);
    await xPool.query("UPDATE outbox_events SET next_attempt_at=NOW()-interval '1 second'");

    for(const [i,source] of ports.entries()){
      assert.deepEqual(await deliver(source,dst,"initial-"+i),{
        claimed:1,delivered:1,duplicates:0,failed:0,lostLeases:0,
      });
    }
    const future=new Date(Date.now()+60000).toISOString();
    const active=()=>queryActiveTokenLinks(dst,token,"2026-10-20T02:00:00Z",future);
    const chain=()=>queryActiveBlockchainSwapEvidence(
      dst,token,"2026-10-20T02:00:00Z",future);
    assert.deepEqual(new Set((await active()).map(row=>row.source_system)),new Set(["x","tg"]));
    assert.equal((await chain()).length,1);
    assert.equal((await queryTokenTimeline(dst,token,"2026-10-20T02:00:00Z",future)).length,0,
      "verified links and swap revisions do not create a phantom generic timeline event");
    assert.equal((await queryActiveTokenLinks(
      dst,token,"2026-10-20T02:00:00Z","2026-10-20T01:30:00Z")).length,0,
      "a 2026-10-24 ETL write is not retrospectively known on 2026-10-20");

    // Historical-as-of assertions only: simulate a source-time destination
    // ingestion in the disposable fixture, never rewrite real arrival clocks.
    await dst.query("UPDATE token_link_observations SET inserted_at=observed_at");
    await dst.query("UPDATE blockchain_swap_evidence_revisions SET inserted_at=observed_at");
    const early=await queryActiveTokenLinks(dst,token,
      "2026-10-20T02:00:00Z","2026-10-20T01:11:00Z");
    assert.deepEqual(early.map(row=>row.source_system),["x"]);
    assert.equal((await queryActiveBlockchainSwapEvidence(
      dst,token,"2026-10-20T02:00:00Z","2026-10-20T01:11:00Z")).length,0);
    assert.equal((await queryActiveTokenLinks(
      dst,token,"2026-10-19T23:59:00Z",future)).length,0,
      "occurredAt and knownAt are separate cutoffs");

    // An edit invalidates all links to the Telegram message, never the
    // independently verified X assertion or supported chain revision.
    const tombstone=invalidated("tg",edited,"edited");
    await commitSource(tgPool,"tg-edit-201",tombstone);
    const retraction=await deliver(ports[1],dst,"tg-edit");
    const sourceState=await tgPool.query(`SELECT event_kind,event_key,processed_at,attempts,
      last_error,lease_owner,lease_until,next_attempt_at FROM outbox_events
      WHERE event_kind='token_links_invalidated'`);
    const inboxState=await dst.query(`SELECT source_system,event_kind,event_key
      FROM intelligence_inbox WHERE event_kind='token_links_invalidated'`);
    const linkState=await dst.query(`SELECT source_system,event_kind,event_key,state
      FROM token_link_observations WHERE event_kind='token_links_invalidated'`);
    assert.equal(retraction.delivered,1,
      `retraction=${JSON.stringify(retraction)} source=${JSON.stringify(sourceState.rows)} inbox=${JSON.stringify(inboxState.rows)} links=${JSON.stringify(linkState.rows)}`);
    assert.equal(retraction.failed,0,JSON.stringify(retraction));
    await dst.query("UPDATE token_link_observations SET inserted_at=observed_at");
    assert.deepEqual((await active()).map(row=>row.source_system),["x"]);
    assert.equal((await chain()).length,1);
    const beforeEdit=await queryActiveTokenLinks(dst,token,
      "2026-10-20T02:00:00Z","2026-10-20T01:20:00Z");
    assert.deepEqual(new Set(beforeEdit.map(row=>row.source_system)),new Set(["x","tg"]));
    assert.equal((await queryActiveTokenLinks(
      dst,formatTokenId("solana","So11111111111111111111111111111111111111112"),
      "2026-10-20T02:00:00Z",future)).length,0);

    // A later X text revision retracts only X's assertion. TG evidence and
    // independently sourced Blockchain evidence must remain untouched.
    const xTombstone=invalidated("x","2026-10-20T01:30:00Z","edited");
    await commitSource(xPool,"x-edit-101",xTombstone);
    const xRetraction=await deliver(ports[0],dst,"x-edit");
    assert.equal(xRetraction.delivered,1);
    assert.equal(xRetraction.failed,0);
    await dst.query("UPDATE token_link_observations SET inserted_at=observed_at");
    assert.deepEqual((await active()).map(row=>row.source_system),["tg"]);
    assert.equal((await chain()).length,1,
      "an X edit must not erase the independent chain observation");

    // A Telegram deletion is a distinct source revision/tombstone. It removes
    // TG's link without changing historical evidence or the chain source.
    const tgDeleted=invalidated("tg","2026-10-20T01:31:00Z","deleted");
    await commitSource(tgPool,"tg-delete-201",tgDeleted);
    const deletion=await deliver(ports[1],dst,"tg-delete");
    assert.equal(deletion.delivered,1);
    assert.equal(deletion.failed,0);
    await dst.query("UPDATE token_link_observations SET inserted_at=observed_at");
    assert.equal((await active()).length,0,
      "X edit plus TG deletion must leave no active social assertion");
    assert.equal((await chain()).length,1,
      "social retractions must not erase chain evidence");

    // A later unsupported raw chain revision supersedes an earlier supported
    // parsed swap. It is not proof that the transaction never happened; it
    // simply removes the previous mint attribution from the active projection.
    const unsupported=revision(
      2,"e","2026-10-20T01:32:00Z",{...chainTransaction,type:"UNKNOWN"},
    );
    assert.equal(unsupported.payload.swapRevision.status,"unsupported");
    assert.equal(unsupported.payload.swapRevision.canonicalTokenId,null);
    sqlite.transaction(()=>emitSqlite(sqlite,unsupported))();
    const superseded=await deliver(ports[2],dst,"chain-unsupported");
    assert.equal(superseded.delivered,1);
    assert.equal(superseded.failed,0);
    assert.equal((await chain()).length,0,
      "latest unsupported raw revision must supersede old supported mint attribution");

    // ACK loss or crash after destination COMMIT for every independent
    // source: replay is duplicate, not a second evidence or active link.
    for(const p of [xPool,tgPool])
      await p.query("UPDATE outbox_events SET processed_at=NULL,lease_owner=NULL,lease_until=NULL");
    sqlite.prepare(
      "UPDATE outbox_events SET processed_at=NULL,lease_owner=NULL,lease_until=NULL"
    ).run();
    const expected=[2,3,2];
    for(const [i,source] of ports.entries()){
      for(let n=0;n<expected[i];n++){
        const replay=await deliver(source,dst,"replay-"+i+"-"+n);
        assert.deepEqual(replay,{
          claimed:1,delivered:0,duplicates:1,failed:0,lostLeases:0,
        });
      }
    }
    assert.equal(await count(dst,"intelligence_inbox"),7);
    assert.equal(await count(dst,"token_link_observations"),5);
    assert.equal(await count(dst,"blockchain_swap_evidence_revisions"),2);
    assert.equal((await active()).length,0);
    assert.equal((await chain()).length,0);
  }finally{
    if(sqlite)sqlite.close();
    for(const p of [xPool,tgPool,dst])if(p)await p.end();
    for(const schema of Object.values(schemas).reverse()){
      try{await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE')}catch{/* keep original failure */}
    }
    await admin.end();
  }
});
