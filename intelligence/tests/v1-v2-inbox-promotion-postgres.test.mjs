import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {
  buildEntityRef,buildEvidenceRef,formatSourceId,
} from "@claude-project/contracts";
import {ingestRegistryEvent,registryEventFingerprint} from "../dist/index.js";

const url=process.env.INTELLIGENCE_TEST_DB_URL;

function event(key){
  const observedAt="2026-11-13T10:00:00.000Z";
  const entity=buildEntityRef({
    kind:"source",canonicalId:formatSourceId("tg","-100321"),
    firstSeenAt:observedAt,lastSeenAt:observedAt,
  });
  const evidenceRef=buildEvidenceRef({
    sourceKind:"tg_message",sourceAccountId:"-100321",messageId:key,
    observedAt,occurredAt:"2026-11-13T09:59:00.000Z",
  });
  return {
    sourceSystem:"tg",eventKind:"message_observed",eventKey:key,
    schemaVersion:"tg-message-v1",entityRefs:[entity],evidenceRef,
  };
}

test("PostgreSQL preserves V1 registry identity while promoting and fencing V2 envelope hashes",{
  skip:!url,
},async()=>{
  const suffix=randomBytes(6).toString("hex");
  const schema="v2_promote_"+suffix;
  const admin=new pg.Client({connectionString:url});
  let pool;
  await admin.connect();
  try{
    await admin.query('CREATE SCHEMA "'+schema+'"');
    await admin.query('SET search_path TO "'+schema+'"');
    for(const file of [
      "001_entity_registry.sql",
      "017_inbox_payload_fingerprint.sql",
      "019_inbox_envelope_fingerprint.sql",
    ]){
      await admin.query(await readFile(new URL("../migrations/"+file,import.meta.url),"utf8"));
    }
    pool=new pg.Pool({connectionString:url,options:"-c search_path="+schema,max:5});

    const original=event("tg:message:-100321:101");
    const registrySha=registryEventFingerprint(original);
    const v2Hash="a".repeat(64);
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      assert.equal(await ingestRegistryEvent(client,original),true);
      await client.query("COMMIT");
      await client.query("BEGIN");
      assert.equal(await ingestRegistryEvent(client,original,{envelopeSha256:v2Hash}),false);
      await client.query("COMMIT");
      await client.query("BEGIN");
      assert.equal(await ingestRegistryEvent(client,original,{envelopeSha256:v2Hash}),false);
      await assert.rejects(
        ingestRegistryEvent(client,original,{envelopeSha256:"b".repeat(64)}),
        /V2 envelope hash mismatch/,
      );
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      assert.equal(await ingestRegistryEvent(client,original),false,
        "a V1 replay after promotion must still match the stable registry fingerprint");
      await client.query("COMMIT");
    }finally{client.release();}

    const stored=(await pool.query(
      "SELECT payload_sha256,envelope_sha256 FROM intelligence_inbox WHERE event_key=$1",
      [original.eventKey],
    )).rows[0];
    assert.equal(stored.payload_sha256,registrySha);
    assert.equal(stored.envelope_sha256,v2Hash);

    const concurrent=event("tg:message:-100321:102");
    const seed=await pool.connect();
    try{
      await seed.query("BEGIN");
      assert.equal(await ingestRegistryEvent(seed,concurrent),true);
      await seed.query("COMMIT");
    }finally{seed.release();}

    const attempt=async(hash)=>{
      const tx=await pool.connect();
      try{
        await tx.query("BEGIN");
        const result=await ingestRegistryEvent(tx,concurrent,{envelopeSha256:hash});
        await tx.query("COMMIT");
        return result;
      }catch(error){
        try{await tx.query("ROLLBACK")}catch{/* preserve first error */}
        throw error;
      }finally{tx.release();}
    };
    const raced=await Promise.allSettled([
      attempt("c".repeat(64)),attempt("d".repeat(64)),
    ]);
    assert.equal(raced.filter(x=>x.status==="fulfilled").length,1,
      "only one concurrent V2 envelope may promote a V1 inbox row");
    assert.equal(raced.filter(x=>x.status==="rejected").length,1,
      "a competing, different envelope must fail closed");
    const concurrentStored=(await pool.query(
      "SELECT payload_sha256,envelope_sha256 FROM intelligence_inbox WHERE event_key=$1",
      [concurrent.eventKey],
    )).rows[0];
    assert.equal(concurrentStored.payload_sha256,registryEventFingerprint(concurrent));
    assert.ok(["c".repeat(64),"d".repeat(64)].includes(concurrentStored.envelope_sha256));
  }finally{
    if(pool)await pool.end();
    await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
    await admin.end();
  }
});
