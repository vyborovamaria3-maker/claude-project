import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {buildEntityRef,buildEvidenceRef,formatTokenId} from "@claude-project/contracts";
import {ingestRegistryEvent,recordSourceCoverageWindow,refreshTokenDailyCrossPlatform} from "../dist/index.js";

const url=process.env.INTELLIGENCE_TEST_DB_URL;
test("PostgreSQL real transaction: replay, provenance and time bounds", {skip:!url},async()=>{
  const client=new pg.Client({connectionString:url});
  await client.connect();
  try{
    await client.query("BEGIN");
    const ddl=await readFile(new URL("../migrations/001_entity_registry.sql",import.meta.url),"utf8");
    await client.query(ddl);
    const mint="So11111111111111111111111111111111111111112";
    const id=formatTokenId("solana",mint);
    const t1="2026-10-18T00:00:00Z",t2="2026-10-18T00:02:00Z";
    const entity=buildEntityRef({kind:"token",canonicalId:id,firstSeenAt:t1,lastSeenAt:t1});
    const tgEvidence=buildEvidenceRef({sourceKind:"tg_message",sourceAccountId:"-100222",messageId:"37",observedAt:t1});
    const tg={sourceSystem:"tg",eventKind:"message_observed",eventKey:"tg:-100222:37:v1",schemaVersion:"v1",entityRefs:[entity],evidenceRef:tgEvidence};
    assert.equal(await ingestRegistryEvent(client,tg),true);
    assert.equal(await ingestRegistryEvent(client,tg),false);
    await assert.rejects(ingestRegistryEvent(client,{
      ...tg,evidenceRef:buildEvidenceRef({
        sourceKind:"tg_message",sourceAccountId:"-100222",messageId:"38",observedAt:t1
      })
    }),/identity collision/);
    const xEntity=buildEntityRef({kind:"token",canonicalId:id,firstSeenAt:t1,lastSeenAt:t2});
    const xEvidence=buildEvidenceRef({sourceKind:"x_tweet",tweetId:"2001",observedAt:t2});
    assert.equal(await ingestRegistryEvent(client,{...tg,sourceSystem:"x",eventKey:"x:2001:v1",entityRefs:[xEntity],evidenceRef:xEvidence}),true);
    const counts=await client.query("SELECT (SELECT COUNT(*) FROM entity_registry) AS entities, (SELECT COUNT(*) FROM entity_evidence) AS evidences, (SELECT COUNT(*) FROM intelligence_inbox) AS inbox");
    assert.equal(Number(counts.rows[0].entities),1);
    assert.equal(Number(counts.rows[0].evidences),2);
    assert.equal(Number(counts.rows[0].inbox),2);
    const times=await client.query("SELECT first_seen_at,last_seen_at FROM entity_registry WHERE kind='token' AND canonical_id=$1",[id]);
    assert.equal(times.rows[0].first_seen_at.toISOString(),"2026-10-18T00:00:00.000Z");
    assert.equal(times.rows[0].last_seen_at.toISOString(),"2026-10-18T00:02:00.000Z");
    await client.query("ROLLBACK");
  } catch(error) {
    try{await client.query("ROLLBACK")}catch{}
    throw error;
  } finally {await client.end();}
});


test("cross-platform refresh SQL keeps transaction, swap evidence and settled trades distinct", {skip:!url},async()=>{
  const client=new pg.Client({connectionString:url});
  await client.connect();
  try{
    await client.query("BEGIN");
    for(const file of [
      "001_entity_registry.sql","002_timeline.sql","003_feature_store.sql",
      "004_token_link_observations.sql","005_blockchain_swap_evidence_revisions.sql",
      "006_cross_platform_analytics.sql",
      "009_ai_analysis.sql",
    ]){
      const ddl=await readFile(new URL("../migrations/"+file,import.meta.url),"utf8");
      await client.query(ddl);
    }
    const now=Date.now();
    const todayStart=Date.UTC(new Date(now).getUTCFullYear(),new Date(now).getUTCMonth(),new Date(now).getUTCDate());
    const day=new Date(todayStart-24*60*60*1000).toISOString().slice(0,10);
    const nextDay=new Date(todayStart).toISOString().slice(0,10);
    const windowStart=day+"T00:00:00.000Z";
    const windowEnd=nextDay+"T00:00:00.000Z";
    const asOf=new Date(now+30_000).toISOString();
    const genericKnownAt=new Date(Math.max(now-2_000,todayStart+1_000)).toISOString();
    const swapKnownAt=genericKnownAt;
    const token=formatTokenId("solana","So11111111111111111111111111111111111111112");
    for(const sourceSystem of ["tg","x","blockchain"]){
      await recordSourceCoverageWindow(client,{
        sourceSystem,windowStart,windowEnd,knownAt:genericKnownAt,status:"complete",
        evidenceCount:0,details:{scope:"timeline_events"},
      });
    }
    await recordSourceCoverageWindow(client,{
      sourceSystem:"blockchain",windowStart,windowEnd,knownAt:swapKnownAt,status:"complete",
      evidenceCount:null,details:{scope:"token_swap_evidence_revisions"},
    });
    const addRevision=async({eventKey,walletId,signature,rawRevision,rawSha256,state,canonicalTokenId,slot,observedAt,occurredAt})=>{
      await client.query(`INSERT INTO intelligence_inbox
        (source_system,event_kind,event_key,schema_version,evidence_source_id,ingested_at)
        VALUES ('blockchain','token_swap_evidence_revision',$1,'chain-token-revision-v1',$2,NOW())`,
      [eventKey,"chain:tx:solana:"+signature]);
      await client.query(`INSERT INTO blockchain_swap_evidence_revisions
        (source_system,event_kind,event_key,wallet_id,signature,raw_revision,raw_sha256,state,
         canonical_token_id,slot,observed_at,occurred_at,details)
        VALUES ('blockchain','token_swap_evidence_revision',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,[
        eventKey,walletId,signature,rawRevision,rawSha256,state,canonicalTokenId,slot,
        observedAt,occurredAt,JSON.stringify({testFixture:true}),
      ]);
    };
    const wallet="solana:11111111111111111111111111111111";
    const observedAt=new Date(now-1_000).toISOString();
    const swapAt=day+"T03:00:00.000Z";
    await addRevision({
      eventKey:"fixture:supported:revision:1",walletId:wallet,signature:"fixture-supported-signature",
      rawRevision:1,rawSha256:"a".repeat(64),state:"supported",canonicalTokenId:token,slot:100,
      observedAt,occurredAt:swapAt,
    });
    await addRevision({
      eventKey:"fixture:retracted:revision:1",walletId:wallet,signature:"fixture-retracted-signature",
      rawRevision:1,rawSha256:"b".repeat(64),state:"supported",canonicalTokenId:token,slot:101,
      observedAt,occurredAt:day+"T04:00:00.000Z",
    });
    await addRevision({
      eventKey:"fixture:retracted:revision:2",walletId:wallet,signature:"fixture-retracted-signature",
      rawRevision:2,rawSha256:"c".repeat(64),state:"unsupported",canonicalTokenId:null,slot:null,
      observedAt:new Date(now-500).toISOString(),occurredAt:null,
    });
    const snapshot=await refreshTokenDailyCrossPlatform(client,token,day,asOf);
    assert.equal(snapshot.tgMentions,0);
    assert.equal(snapshot.xMentions,0);
    assert.equal(snapshot.chainTransactions,0);
    assert.equal(snapshot.chainTrades,null);
    assert.equal(snapshot.chainVolumeUsd,null);
    assert.equal(snapshot.chainSwapEvidenceCount,1);
    assert.equal(snapshot.firstTradeAt,null);
    assert.equal(snapshot.firstSwapEvidenceAt,new Date(swapAt).toISOString());
    assert.ok(snapshot.maxInputObservedAt<=snapshot.asOf);
    await client.query("ROLLBACK");
  }catch(error){
    try{await client.query("ROLLBACK")}catch{}
    throw error;
  }finally{
    await client.end();
  }
});
