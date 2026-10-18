import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {buildEntityRef,buildEvidenceRef,formatTokenId} from "@claude-project/contracts";
import {ingestRegistryEvent} from "../dist/index.js";

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
