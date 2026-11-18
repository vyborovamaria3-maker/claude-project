import test from "node:test";
import assert from "node:assert/strict";
import { postgresSourcePoolOptions, checkDestination } from "../scripts/etl-connections.mjs";

test("status and fingerprint-backfill source sessions default to PostgreSQL read-only transaction mode",()=>{
  const options=postgresSourcePoolOptions("x",false,{X_SOURCE_DATABASE_URL:"postgres://example/source"});
  assert.equal(options.connectionString,"postgres://example/source");
  assert.equal(options.application_name,"potapoff-intelligence-source-reader");
  assert.equal(options.options,"-c default_transaction_read_only=on");
  assert.equal(options.query_timeout,30_000);
  assert.equal(options.statement_timeout,30_000);
});

test("supervisor source sessions retain write capability only for outbox lease/ACK",()=>{
  const options=postgresSourcePoolOptions("tg",true,{TG_SOURCE_DATABASE_URL:"postgres://example/source"});
  assert.equal(options.connectionString,"postgres://example/source");
  assert.equal(options.application_name,"potapoff-intelligence-source-writer");
  assert.equal(Object.hasOwn(options,"options"),false);
});

test("unknown source, missing DSN and ambiguous mode fail closed",()=>{
  assert.throws(()=>postgresSourcePoolOptions("ethereum",false,{}),/invalid PostgreSQL source connection mode/);
  assert.throws(()=>postgresSourcePoolOptions("x",false,{}),/missing required source\/destination configuration/);
  assert.throws(()=>postgresSourcePoolOptions("x",1,{X_SOURCE_DATABASE_URL:"postgres://example/source"}),/invalid PostgreSQL source connection mode/);
});


test("source consumers fail closed while legacy inbox fingerprints remain",async()=>{
  const ready={
    inbox:true,registry:true,evidence:true,timeline:true,token_links:true,
    blockchain_revisions:true,inbox_fingerprint:true,
  };
  const pool={query:async sql=>{
    if(sql.includes("payload_sha256 IS NULL"))return {rows:[{pending:true}]};
    return {rows:[ready]};
  }};
  await assert.rejects(
    checkDestination(pool),
    /legacy Intelligence inbox fingerprints pending/,
  );
  await checkDestination(pool,{allowLegacyFingerprints:true});
});

test("source consumers pass fingerprint gate after bounded backfill completes",async()=>{
  const ready={
    inbox:true,registry:true,evidence:true,timeline:true,token_links:true,
    blockchain_revisions:true,inbox_fingerprint:true,
  };
  const pool={query:async sql=>{
    if(sql.includes("payload_sha256 IS NULL"))return {rows:[{pending:false}]};
    return {rows:[ready]};
  }};
  await checkDestination(pool);
});

test("fingerprint gate does not mask missing required migrations",async()=>{
  const pool={query:async()=>({rows:[{
    inbox:true,registry:true,evidence:true,timeline:true,token_links:true,
    blockchain_revisions:true,inbox_fingerprint:false,
  }]})};
  await assert.rejects(checkDestination(pool,{allowLegacyFingerprints:true}),/migration 017 required/);
});


test("Discord source pool uses its own PostgreSQL DSN and least-privilege reader mode",()=>{
 const options=postgresSourcePoolOptions("discord",false,{DISCORD_SOURCE_DATABASE_URL:"postgres://example/discord"});
 assert.equal(options.connectionString,"postgres://example/discord");
 assert.equal(options.application_name,"potapoff-intelligence-discord-source-reader");
 assert.equal(options.options,"-c default_transaction_read_only=on");
});
test("Discord claims fail closed until migration 022 evidence/timeline constraints exist",async()=>{
 const pool={query:async sql=>{
  if(sql.includes("payload_sha256 IS NULL"))return{rows:[{pending:false}]};
  return{rows:[{inbox:true,registry:true,evidence:true,timeline:true,token_links:true,
   blockchain_revisions:true,inbox_fingerprint:true,
   inbox_envelope_fingerprint:true,inbox_envelope_fingerprint_constraint:true,
   inbox_envelope_fingerprint_definition:"CHECK (envelope_sha256 IS NULL OR envelope_sha256 ~ '^[a-f0-9]{64}$')",
   discord_evidence_definition:"CHECK (evidence_kind IN ('x_tweet','tg_message','chain_tx'))",
   discord_timeline_definition:"CHECK (timeline_kind IN ('tweet_published','tg_message_published'))"}]};
 }};
 await assert.rejects(checkDestination(pool,{requireDiscordEvidence:true,allowLegacyFingerprints:true}),/migration 022 required/);
});
