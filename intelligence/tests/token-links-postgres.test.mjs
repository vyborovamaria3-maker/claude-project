import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {
  buildEntityRef,buildEvidenceRef,buildVerifiedTokenLinkEvent,
  buildTokenLinksInvalidatedEvent,formatSourceId,formatTokenId,
} from "@claude-project/contracts";
import {runDeliveryBatch,queryActiveTokenLinks,queryTokenTimeline} from "../dist/index.js";

const url=process.env.INTELLIGENCE_TEST_DB_URL;
const mint="So11111111111111111111111111111111111111112";
const token=formatTokenId("solana",mint);
const times=["2026-10-20T01:01:00Z","2026-10-20T01:04:00Z","2026-10-20T01:07:00Z"];
const occurred="2026-10-19T22:00:00Z";

function evidence(observedAt){
  return buildEvidenceRef({
    sourceKind:"tg_message",sourceAccountId:"1234",messageId:"42",
    observedAt,occurredAt,parserVersion:"tg-mint-verifier-v1",
  });
}
function ref(observedAt){
  return buildEntityRef({
    kind:"source",canonicalId:formatSourceId("tg","1234"),
    firstSeenAt:observedAt,lastSeenAt:observedAt,
  });
}
function verified(at,revision){
  return buildVerifiedTokenLinkEvent({
    sourceSystem:"tg",sourceEntity:ref(at),evidenceRef:evidence(at),
    mint,matchedLiteralMint:mint,sourceRevisionSha256:revision,
    mintVerification:{
      chainId:"solana-mainnet",method:"spl_mint_account",
      tokenProgram:"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      provider:"alchemy-solana-rpc",checkedAt:at,
    },
  });
}
function invalidated(at){
  return buildTokenLinksInvalidatedEvent({
    sourceSystem:"tg",sourceEntity:ref(at),evidenceRef:evidence(at),
    reason:"edited",sourceRevisionSha256:"c".repeat(64),
  });
}
function envelope(event){
  return {...event,id:"1",attempts:0,leaseOwner:"worker",
    leaseUntil:"2026-10-20T02:00:00Z"};
}
async function send(destination,event){
  let acked=0;
  const result=await runDeliveryBatch({
    claim:async()=>[envelope(event)],
    ack:async()=>{acked++;return true;},
    fail:async()=>true,
  },destination,{workerId:"worker",batchSize:1,leaseMs:120000});
  assert.equal(result.failed,0);
  assert.equal(acked,1);
  return result;
}

test("real PostgreSQL: late arrivals, edit retractions, historical as-of and replay remain correct",{
  skip:!url,
},async()=>{
  const schema="token_links_"+randomBytes(5).toString("hex");
  const admin=new pg.Client({connectionString:url});
  let pool;
  await admin.connect();
  try{
    await admin.query('CREATE SCHEMA "'+schema+'"');
    await admin.query('SET search_path TO "'+schema+'"');
    for(const filename of ["001_entity_registry.sql","002_timeline.sql","004_token_link_observations.sql"]){
      await admin.query(await readFile(new URL("../migrations/"+filename,import.meta.url),"utf8"));
    }
    pool=new pg.Pool({connectionString:url,options:"-c search_path="+schema,max:3});
    const initial=verified(times[0],"a".repeat(64));
    const edit=invalidated(times[1]);
    const restored=verified(times[2],"b".repeat(64));
    // Deliver out of order: the correction must win even if the source
    // retry delivers an older verified assertion later.
    assert.equal((await send(pool,edit)).delivered,1);
    assert.equal((await send(pool,initial)).delivered,1);
    let current=await queryActiveTokenLinks(pool,token,"2026-10-20T01:10:00Z","2026-10-20T01:05:00Z");
    assert.equal(current.length,0,"late old confirmation cannot resurrect edited message");
    current=await queryActiveTokenLinks(pool,token,"2026-10-20T01:10:00Z","2026-10-20T01:02:00Z");
    assert.equal(current.length,1,"historical as-of before edit still contains confirmed evidence");
    assert.equal(current[0].evidence_source_id,"tg:message:1234:42");
    assert.equal((await queryActiveTokenLinks(pool,token,"2026-10-19T21:00:00Z","2026-10-20T01:05:00Z")).length,0);
    assert.equal((await queryActiveTokenLinks(pool,formatTokenId("solana",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
      "2026-10-20T01:10:00Z","2026-10-20T01:05:00Z")).length,0);

    assert.equal((await send(pool,restored)).delivered,1);
    current=await queryActiveTokenLinks(pool,token,"2026-10-20T01:10:00Z","2026-10-20T01:08:00Z");
    assert.equal(current.length,1,"reverified newer message revision can become active");
    assert.equal(current[0].source_revision_sha256,"b".repeat(64));
    assert.equal((await send(pool,restored)).duplicates,1,"same event must be idempotent");
    assert.equal((await send(pool,edit)).duplicates,1,"same tombstone must be idempotent");
    assert.equal((await pool.query("SELECT count(*)::integer AS n FROM token_link_observations")).rows[0].n,3);
    assert.equal((await pool.query("SELECT count(*)::integer AS n FROM intelligence_inbox")).rows[0].n,3);
    assert.equal((await queryTokenTimeline(pool,token,"2026-10-20T01:10:00Z","2026-10-20T01:10:00Z")).length,
      0,"no phantom irreversible token timeline is emitted");

    // Same envelope identity but changed proof/evidence must be rejected.
    const forged={...restored,payload:{...restored.payload,tokenLink:{
      ...restored.payload.tokenLink,mintVerification:{
        ...restored.payload.tokenLink.mintVerification,
        provider:"fake-provider",
      },
    }}};
    let nack=0;
    const result=await runDeliveryBatch({
      claim:async()=>[envelope(forged)],
      ack:async()=>true,
      fail:async()=>{nack++;return true;},
    },pool,{workerId:"worker",batchSize:1,leaseMs:120000});
    assert.equal(result.delivered,0);
    assert.equal(result.failed,1);
    assert.equal(nack,1);
    assert.equal((await pool.query("SELECT count(*)::integer AS n FROM token_link_observations")).rows[0].n,3);
  }finally{
    if(pool)await pool.end();
    await admin.query("SET search_path TO public");
    await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
    await admin.end();
  }
});
