import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {buildEntityRef,buildEvidenceRef,buildTimelineEvent,formatTokenId} from "@claude-project/contracts";
import {ingestRegistryEvent,ingestTimelineEvent,queryTokenTimeline} from "../dist/index.js";

const url=process.env.INTELLIGENCE_TEST_DB_URL;
test("PostgreSQL timeline excludes late-observed historical events", {skip:!url},async()=>{
  const db=new pg.Client({connectionString:url});
  await db.connect();
  try{
    await db.query("BEGIN");
    for(const migration of ["001_entity_registry.sql","002_timeline.sql"]){
      await db.query(await readFile(new URL("../migrations/"+migration,import.meta.url),"utf8"));
    }
    const token=formatTokenId("solana","So11111111111111111111111111111111111111112");
    const entity=buildEntityRef({kind:"token",canonicalId:token,
      firstSeenAt:"2026-10-18T00:00:00Z",lastSeenAt:"2026-10-18T00:20:00Z"});
    const evidence=buildEvidenceRef({sourceKind:"x_tweet",tweetId:"987654",
      occurredAt:"2026-10-18T00:00:00Z",observedAt:"2026-10-18T00:20:00Z"});
    const registry={sourceSystem:"x",eventKind:"tweet_observed",eventKey:"x:987654:v1",
      schemaVersion:"v1",entityRefs:[entity],evidenceRef:evidence};
    await ingestRegistryEvent(db,registry);
    const timeline=buildTimelineEvent({kind:"tweet_published",eventKey:registry.eventKey,
      entityRefs:[entity],evidenceRef:evidence,
      occurredAt:"2026-10-18T00:00:00Z",
      observedAt:"2026-10-18T00:20:00Z",payload:{source:"public"}});
    assert.equal(await ingestTimelineEvent(db,"x","tweet_observed",timeline),true);
    assert.equal(await ingestTimelineEvent(db,"x","tweet_observed",timeline),false);
    assert.equal((await queryTokenTimeline(db,token,"2026-10-18T00:10:00Z","2026-10-18T00:10:00Z")).length,0);
    assert.equal((await queryTokenTimeline(db,token,"2026-10-18T00:10:00Z","2026-10-18T00:30:00Z")).length,1);
    assert.equal((await queryTokenTimeline(db,token,"2026-10-17T23:59:00Z","2026-10-18T00:30:00Z")).length,0);
    await db.query("ROLLBACK");
  }catch(error){try{await db.query("ROLLBACK")}catch{} throw error;}
  finally{await db.end();}
});
