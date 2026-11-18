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


test("Discord source uses its dedicated PostgreSQL DSN and source-writer role",()=>{
  const write=postgresSourcePoolOptions("discord",true,{DISCORD_SOURCE_DATABASE_URL:"postgres://example/discord"});
  assert.equal(write.connectionString,"postgres://example/discord");
  assert.equal(write.application_name,"potapoff-intelligence-source-writer");
  assert.equal(Object.hasOwn(write,"options"),false);
  const read=postgresSourcePoolOptions("discord",false,{DISCORD_SOURCE_DATABASE_URL:"postgres://example/discord"});
  assert.equal(read.options,"-c default_transaction_read_only=on");
});
test("Discord readiness requires both validated migration 022 checks",async()=>{
  const pool={query:async(sql)=>({rows:[{
    inbox:true,registry:true,evidence:true,timeline:true,token_links:true,
    inbox_fingerprint:true,discord_evidence_constraint:false,discord_timeline_constraint:false,
  }]})};
  await assert.rejects(checkDestination(pool,{requireDiscordContracts:true,allowLegacyFingerprints:true}),/migration 022/);
});
