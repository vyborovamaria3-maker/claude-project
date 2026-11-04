import test from "node:test";
import assert from "node:assert/strict";
import { postgresSourcePoolOptions } from "../scripts/etl-connections.mjs";

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
