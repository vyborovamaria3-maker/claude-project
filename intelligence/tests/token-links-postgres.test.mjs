import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {
  buildEntityRef,buildEvidenceRef,buildVerifiedTokenLinkEvent,
  buildTokenLinksInvalidatedEvent,formatSourceId,formatAuthorId,formatTokenId,canonicalTokenIdFromNative,
} from "@claude-project/contracts";
import {runDeliveryBatch,queryActiveTokenLinks,queryTokenTimeline,storeEncryptedEventText,readEncryptedEventText} from "../dist/index.js";

const url=process.env.INTELLIGENCE_TEST_DB_URL;
const mint="So11111111111111111111111111111111111111112";
const token=formatTokenId("solana",mint);
const times=["2026-10-20T01:01:00Z","2026-10-20T01:04:00Z","2026-10-20T01:07:00Z"];
const occurred="2026-10-19T22:00:00Z";

function evidence(observedAt){
  return buildEvidenceRef({
    sourceKind:"tg_message",sourceAccountId:"1234",messageId:"42",
    observedAt,occurredAt:occurred,parserVersion:"tg-mint-verifier-v1",
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
    for(const filename of ["001_entity_registry.sql","002_timeline.sql","003_feature_store.sql",
      "004_token_link_observations.sql","005_blockchain_swap_evidence_revisions.sql",
      "006_cross_platform_analytics.sql","008_alert_status_history.sql","009_ai_analysis.sql",
      "010_intelligence_governance.sql"]){
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
    assert.equal((await queryActiveTokenLinks(pool,token,
      "2026-10-20T01:10:00Z","2026-10-20T01:05:00Z")).length,0,
      "late Intelligence delivery cannot retroactively count as known");
    await pool.query("UPDATE token_link_observations SET inserted_at=observed_at");
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
    await pool.query("UPDATE token_link_observations SET inserted_at=observed_at");
    current=await queryActiveTokenLinks(pool,token,"2026-10-20T01:10:00Z","2026-10-20T01:08:00Z");
    assert.equal(current.length,1,"reverified newer message revision can become active");
    assert.equal(current[0].source_revision_sha256,"b".repeat(64));
    assert.equal((await send(pool,restored)).duplicates,1,"same event must be idempotent");
    assert.equal((await send(pool,edit)).duplicates,1,"same tombstone must be idempotent");
    assert.equal((await pool.query("SELECT count(*)::integer AS n FROM token_link_observations")).rows[0].n,3);
    assert.equal((await pool.query("SELECT count(*)::integer AS n FROM intelligence_inbox")).rows[0].n,3);
    assert.equal((await queryTokenTimeline(pool,token,"2026-10-20T01:10:00Z","2026-10-20T01:10:00Z")).length,
      0,"no phantom irreversible token timeline is emitted");

    // The same verified mint is a single canonical token across native TG and X
    // evidence. A source-specific edit retracts only its own assertion.
    assert.equal(canonicalTokenIdFromNative("solana-mainnet",mint),token);
    assert.equal(canonicalTokenIdFromNative("solana",mint),token);
    const xAt="2026-10-20T01:09:00Z";
    const xRef=buildEntityRef({
      kind:"author",canonicalId:formatAuthorId("x","9007199254740993"),
      firstSeenAt:xAt,lastSeenAt:xAt,
    });
    const xEvidence=buildEvidenceRef({
      sourceKind:"x_tweet",tweetId:"1234567890123456789",
      observedAt:xAt,occurredAt:"2026-10-19T22:02:00Z",
      parserVersion:"x-mint-verifier-v1",
    });
    const xVerified=buildVerifiedTokenLinkEvent({
      sourceSystem:"x",sourceEntity:xRef,evidenceRef:xEvidence,
      mint,matchedLiteralMint:mint,sourceRevisionSha256:"d".repeat(64),
      mintVerification:{
        chainId:"solana-mainnet",method:"spl_mint_account",
        tokenProgram:"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        provider:"alchemy-solana-rpc",checkedAt:xAt,
      },
    });
    assert.equal((await send(pool,xVerified)).delivered,1);
    await pool.query("UPDATE token_link_observations SET inserted_at=observed_at");
    current=await queryActiveTokenLinks(pool,token,
      "2026-10-20T01:11:00Z","2026-10-20T01:10:00Z");
    assert.deepEqual(new Set(current.map(row=>row.source_system)),new Set(["x","tg"]));
    assert.deepEqual(new Set(current.map(row=>row.evidence_source_id)),
      new Set(["x:tweet:1234567890123456789","tg:message:1234:42"]));
    const xEditAt="2026-10-20T01:10:00Z";
    const xEdit=buildTokenLinksInvalidatedEvent({
      sourceSystem:"x",
      sourceEntity:buildEntityRef({
        kind:"author",canonicalId:formatAuthorId("x","9007199254740993"),
        firstSeenAt:xEditAt,lastSeenAt:xEditAt,
      }),
      evidenceRef:buildEvidenceRef({
        sourceKind:"x_tweet",tweetId:"1234567890123456789",
        observedAt:xEditAt,occurredAt:"2026-10-19T22:02:00Z",
        parserVersion:"x-mint-verifier-v1",
      }),
      reason:"edited",sourceRevisionSha256:"e".repeat(64),
    });
    assert.equal((await send(pool,xEdit)).delivered,1);
    await pool.query("UPDATE token_link_observations SET inserted_at=observed_at");
    current=await queryActiveTokenLinks(pool,token,
      "2026-10-20T01:11:00Z","2026-10-20T01:11:00Z");
    assert.deepEqual(current.map(row=>row.source_system),["tg"],
      "X retraction must not remove an independent verified TG mention");
    assert.equal((await send(pool,xVerified)).duplicates,1,
      "replaying stale verified X evidence must not resurrect the link");
    assert.equal((await send(pool,xEdit)).duplicates,1);
    assert.equal((await queryActiveTokenLinks(pool,
      formatTokenId("solana","EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
      "2026-10-20T01:11:00Z","2026-10-20T01:11:00Z")).length,0);

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
    assert.equal((await pool.query("SELECT count(*)::integer AS n FROM token_link_observations")).rows[0].n,5);
    // An encrypted message revision must be cryptoshredded in the SAME
    // destination transaction as a validated link retraction.
    const snapshotKey=randomBytes(32);
    const messageRef="tg:message:1234:42";
    const messageEventKey="tg:source-test:revision";
    await pool.query(`INSERT INTO intelligence_inbox
      (source_system,event_kind,event_key,schema_version,evidence_source_id)
      VALUES('tg','message_observed',$1,'tg-message-v1',$2)`,
      [messageEventKey,messageRef]);
    await pool.query(`INSERT INTO timeline_events
      (source_system,source_event_kind,event_key,timeline_kind,occurred_at,observed_at,
       evidence_source_id,schema_version,payload)
      VALUES('tg','message_observed',$1,'tg_message_published',
       '2026-10-19T22:00:00Z','2026-10-20T01:08:00Z',$2,'timeline-v1','{}')`,
      [messageEventKey,messageRef]);
    const snapshot={sourceSystem:"tg",sourceEventKind:"message_observed",eventKey:messageEventKey};
    assert.equal(await storeEncryptedEventText(pool,{...snapshot,
      observedAt:"2026-10-20T01:08:00Z",text:"Sensitive private source revision",
      key:snapshotKey,keyRef:"fixture-key-v1",retentionDays:7}),true);
    assert.equal(await readEncryptedEventText(pool,snapshotKey,{...snapshot,keyRef:"fixture-key-v1"}),
      "Sensitive private source revision");
    // Revoke a link AFTER verified revisions exist; replay cannot enqueue twice.
    const newerDelete=invalidated("2026-10-20T01:09:00Z");
    assert.equal((await send(pool,newerDelete)).delivered,1);
    assert.equal((await send(pool,newerDelete)).duplicates,1);
    const destroyed=await pool.query(`SELECT text_ciphertext,purged_at
      FROM event_text_snapshots WHERE event_key=$1`,[messageEventKey]);
    assert.equal(destroyed.rows.length,1);
    assert.equal(destroyed.rows[0].text_ciphertext,null);
    assert.ok(destroyed.rows[0].purged_at instanceof Date);
    assert.equal(await readEncryptedEventText(pool,snapshotKey,{...snapshot,keyRef:"fixture-key-v1"}),null);

    const changes=await pool.query(`SELECT reason,count(*)::integer AS n
      FROM analytics_invalidation_queue GROUP BY reason ORDER BY reason`);
    assert.ok(changes.rows.some(row=>row.reason==="link_invalidated"&&row.n===2));
    const retractions=await pool.query(`SELECT source_system,count(*)::integer AS n
      FROM analytics_invalidation_queue WHERE reason='link_invalidated'
      GROUP BY source_system ORDER BY source_system`);
    assert.deepEqual(retractions.rows,[{source_system:"tg",n:1},{source_system:"x",n:1}],
      "one recomputation per independent source retraction; duplicates do not enqueue again");
    assert.equal((await pool.query("SELECT count(*)::integer AS n FROM analytics_invalidation_log")).rows[0].n,
      (await pool.query("SELECT count(*)::integer AS n FROM analytics_invalidation_queue")).rows[0].n);
  }finally{
    if(pool)await pool.end();
    await admin.query("SET search_path TO public");
    await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
    await admin.end();
  }
});
