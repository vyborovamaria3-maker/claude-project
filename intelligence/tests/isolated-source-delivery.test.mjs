import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {
  buildEntityRef,buildEvidenceRef,formatAuthorId,formatSourceId,formatTokenId,
  buildVerifiedTokenLinkEvent,buildTokenLinksInvalidatedEvent,
} from "@claude-project/contracts";
import {
  POSTGRES_OUTBOX_DDL,emitPostgres,claimPostgres,ackPostgres,failPostgres,
} from "@claude-project/event-outbox";
import {runDeliveryBatch,queryActiveTokenLinks} from "../dist/index.js";

const url=process.env.INTELLIGENCE_TEST_DB_URL;

test("independent X/TG PG sources deliver to a separate Intelligence schema with ACK-after-commit",{skip:!url},async()=>{
  const suffix=randomBytes(5).toString("hex");
  const sources={x:"source_x_"+suffix,tg:"source_tg_"+suffix,dst:"intelligence_"+suffix};
  const admin=new pg.Client({connectionString:url});
  let xPool, tgPool, destPool;
  await admin.connect();
  try {
    for (const schema of Object.values(sources)) {
      await admin.query('CREATE SCHEMA "'+schema+'"');
    }
    for (const name of ["x","tg"]) {
      await admin.query('SET search_path TO "'+sources[name]+'"');
      await admin.query(POSTGRES_OUTBOX_DDL);
    }
    await admin.query('SET search_path TO "'+sources.dst+'"');
    for (const name of ["001_entity_registry.sql","002_timeline.sql","004_token_link_observations.sql"]) {
      await admin.query(await readFile(new URL("../migrations/"+name,import.meta.url),"utf8"));
    }
    const poolFor=(schema)=>new pg.Pool({connectionString:url,options:"-c search_path="+schema,max:3});
    xPool=poolFor(sources.x); tgPool=poolFor(sources.tg); destPool=poolFor(sources.dst);
    for (const [pool, schema] of [[xPool,sources.x],[tgPool,sources.tg],[destPool,sources.dst]]) {
      assert.equal((await pool.query("SELECT current_schema() AS name")).rows[0].name,schema);
    }
    const when="2026-10-18T01:00:00Z";
    const fixtures=[
      {pool:xPool,platform:"x",eventKind:"tweet_observed",eventKey:"x:tweet:900000:v1",
        kind:"author",canonicalId:formatAuthorId("x","9999"),
        evidence:buildEvidenceRef({sourceKind:"x_tweet",tweetId:"900000",observedAt:when})},
      {pool:tgPool,platform:"tg",eventKind:"message_observed",eventKey:"tg:12345:77:v1",
        kind:"source",canonicalId:formatSourceId("tg","12345"),
        evidence:buildEvidenceRef({sourceKind:"tg_message",sourceAccountId:"12345",messageId:"77",observedAt:when})},
    ];
    for(const item of fixtures) {
      const ref=buildEntityRef({kind:item.kind,canonicalId:item.canonicalId,firstSeenAt:when,lastSeenAt:when});
      const registryEvent={
        sourceSystem:item.platform,eventKind:item.eventKind,eventKey:item.eventKey,
        schemaVersion:"fixture-v1",entityRefs:[ref],evidenceRef:item.evidence,
      };
      const event={
        sourceSystem:item.platform,eventKind:item.eventKind,eventKey:item.eventKey,
        schemaVersion:"fixture-v1",payload:{registryEvent},
      };
      const client=await item.pool.connect();
      try {
        await client.query("BEGIN");
        await emitPostgres(client,event);
        await client.query("COMMIT");
      } catch(error) {
        try{await client.query("ROLLBACK")}catch{}
        throw error;
      }finally{client.release()}
    }
    const port=(pool)=>({
      claim:options=>claimPostgres(pool,options),
      ack:event=>ackPostgres(pool,event.id,event.leaseOwner,event.leaseUntil),
      fail:(event,reason,next)=>failPostgres(pool,event.id,event.leaseOwner,event.leaseUntil,reason,next),
    });
    const xStats=await runDeliveryBatch(port(xPool),destPool,{workerId:"x-worker",batchSize:5,leaseMs:120000});
    assert.equal(xStats.delivered,1);
    assert.equal(xStats.failed,0);
    assert.equal((await tgPool.query("SELECT count(*)::integer AS n FROM outbox_events WHERE processed_at IS NULL")).rows[0].n,1,
      "TG source is independent; X ACK must not touch it");
    const tgStats=await runDeliveryBatch(port(tgPool),destPool,{workerId:"tg-worker",batchSize:5,leaseMs:120000});
    assert.equal(tgStats.delivered,1);
    assert.equal(tgStats.failed,0);
    const inbox=await destPool.query("SELECT source_system,evidence_source_id FROM intelligence_inbox ORDER BY source_system");
    assert.deepEqual(inbox.rows.map(x=>x.source_system),["tg","x"]);
    assert.deepEqual(inbox.rows.map(x=>x.evidence_source_id),["tg:message:12345:77","x:tweet:900000"]);
    assert.equal((await destPool.query("SELECT count(*)::integer AS n FROM entity_registry")).rows[0].n,2);
    for(const pool of [xPool,tgPool]) {
      assert.equal((await pool.query("SELECT count(*)::integer AS n FROM outbox_events WHERE processed_at IS NOT NULL")).rows[0].n,1);
    }
    // Commit succeeded but ACK state was lost, so source redelivers safely.
    await xPool.query("UPDATE outbox_events SET processed_at=NULL,lease_owner=NULL,lease_until=NULL");
    const replay=await runDeliveryBatch(port(xPool),destPool,{workerId:"x-replay",batchSize:1,leaseMs:120000});
    assert.equal(replay.duplicates,1);
    assert.equal(replay.delivered,0);
    assert.equal((await destPool.query("SELECT count(*)::integer AS n FROM entity_evidence")).rows[0].n,2);

    // Separate real PostgreSQL outboxes publish actual token-link contract
    // envelopes (not a mocked claim function). Destination transaction commit
    // must precede an independent source ACK, and a source edit cannot revoke
    // evidence from another social platform.
    const mint="So11111111111111111111111111111111111111112";
    const token=formatTokenId("solana",mint);
    const seen="2026-10-22T13:00:00Z";
    const cutoff="2026-10-18T02:00:00Z";
    const knownAt="2026-10-23T00:00:00Z";
    const inputs=[
      {
        pool:xPool,sourceSystem:"x",
        ref:buildEntityRef({
          kind:"author",canonicalId:formatAuthorId("x","9999"),
          firstSeenAt:seen,lastSeenAt:seen,
        }),
        evidence:buildEvidenceRef({
          sourceKind:"x_tweet",tweetId:"900001",
          occurredAt:"2026-10-18T01:20:00Z",observedAt:seen,
          parserVersion:"x-mint-verifier-v1",
        }),
        revision:"a".repeat(64),
      },{
        pool:tgPool,sourceSystem:"tg",
        ref:buildEntityRef({
          kind:"source",canonicalId:formatSourceId("tg","12345"),
          firstSeenAt:seen,lastSeenAt:seen,
        }),
        evidence:buildEvidenceRef({
          sourceKind:"tg_message",sourceAccountId:"12345",messageId:"78",
          occurredAt:"2026-10-18T01:22:00Z",observedAt:seen,
          parserVersion:"tg-mint-verifier-v1",
        }),
        revision:"b".repeat(64),
      },
    ];
    const emitInNativeTransaction=async(pool,event)=>{
      const tx=await pool.connect();
      try{
        await tx.query("BEGIN");
        await emitPostgres(tx,event);
        await tx.query("COMMIT");
      }catch(error){
        try{await tx.query("ROLLBACK")}catch{}
        throw error;
      }finally{tx.release()}
    };
    for(const item of inputs){
      const verified=buildVerifiedTokenLinkEvent({
        sourceSystem:item.sourceSystem,
        sourceEntity:item.ref,evidenceRef:item.evidence,
        mint,matchedLiteralMint:mint,
        sourceRevisionSha256:item.revision,
        mintVerification:{
          chainId:"solana-mainnet",method:"spl_mint_account",
          tokenProgram:"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          provider:"alchemy-solana-rpc",checkedAt:seen,
        },
      });
      await emitInNativeTransaction(item.pool,verified);
      const delivered=await runDeliveryBatch(port(item.pool),destPool,{
        workerId:item.sourceSystem+"-token-verified",batchSize:1,leaseMs:120000,
      });
      assert.equal(delivered.delivered,1);
      assert.equal(delivered.failed,0);
    }
    const beforeEdit=await queryActiveTokenLinks(destPool,token,cutoff,knownAt);
    assert.deepEqual(new Set(beforeEdit.map(row=>row.source_system)),
      new Set(["tg","x"]));
    assert.deepEqual(new Set(beforeEdit.map(row=>row.evidence_source_id)),
      new Set(["tg:message:12345:78","x:tweet:900001"]));
    // Tombstone is source-wide: a new TG message revision revokes TG only.
    const editedAt="2026-10-22T13:05:00Z";
    const tgEdit=buildTokenLinksInvalidatedEvent({
      sourceSystem:"tg",
      sourceEntity:buildEntityRef({
        kind:"source",canonicalId:formatSourceId("tg","12345"),
        firstSeenAt:editedAt,lastSeenAt:editedAt,
      }),
      evidenceRef:buildEvidenceRef({
        sourceKind:"tg_message",sourceAccountId:"12345",messageId:"78",
        occurredAt:"2026-10-18T01:22:00Z",observedAt:editedAt,
        parserVersion:"tg-mint-verifier-v1",
      }),
      reason:"edited",sourceRevisionSha256:"c".repeat(64),
    });
    await emitInNativeTransaction(tgPool,tgEdit);
    const retraction=await runDeliveryBatch(port(tgPool),destPool,{
      workerId:"tg-token-retraction",batchSize:1,leaseMs:120000,
    });
    assert.equal(retraction.delivered,1);
    assert.equal(retraction.failed,0);
    assert.deepEqual((await queryActiveTokenLinks(destPool,token,cutoff,knownAt))
      .map(row=>row.source_system),["x"]);
    // Simulate process restart/ACK loss after destination COMMIT for X proof
    // and TG tombstone. Replays may be claimed but must NOT resurrect the TG
    // assertion or duplicate destination evidence.
    await xPool.query(
      "UPDATE outbox_events SET processed_at=NULL,lease_owner=NULL,lease_until=NULL " +
      "WHERE event_kind='token_link_verified'",
    );
    await tgPool.query(
      "UPDATE outbox_events SET processed_at=NULL,lease_owner=NULL,lease_until=NULL " +
      "WHERE event_kind='token_links_invalidated'",
    );
    for(const [source,workerId] of [[xPool,"x-proof-replay"],[tgPool,"tg-edit-replay"]]){
      const replayLink=await runDeliveryBatch(port(source),destPool,{
        workerId,batchSize:1,leaseMs:120000,
      });
      assert.equal(replayLink.duplicates,1);
      assert.equal(replayLink.delivered,0);
      assert.equal(replayLink.failed,0);
    }
    assert.deepEqual((await queryActiveTokenLinks(destPool,token,cutoff,knownAt))
      .map(row=>row.source_system),["x"]);
    const storedLinks=await destPool.query(
      "SELECT source_system,event_kind,evidence_source_id FROM token_link_observations " +
      "ORDER BY source_system,event_kind",
    );
    assert.equal(storedLinks.rows.length,3);
    assert.deepEqual(
      new Set(storedLinks.rows.map(row=>row.evidence_source_id)),
      new Set(["tg:message:12345:78","x:tweet:900001"]),
    );

  }finally{
    if(xPool)await xPool.end();
    if(tgPool)await tgPool.end();
    if(destPool)await destPool.end();
    for(const schema of Object.values(sources).reverse()) {
      try{await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE')}catch{}
    }
    await admin.end();
  }
});
