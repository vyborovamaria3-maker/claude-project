"use strict";
const assert=require("node:assert/strict");
const Database=require("better-sqlite3");
const {
  enabled,ensureSchema,buildWalletRawEvent,emitRawChainOutbox,
}=require("./blockchain-intelligence-outbox.cjs");
const {persistEvents}=require("./blockchain-seed-collector.cjs");

const old=process.env.BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED;
const db=new Database(":memory:");
const wallet="1".repeat(32); // 32-byte zero public key, syntax fixture only
const signature="1".repeat(64); // 64-byte zero signature, syntax fixture only
const tx={signature,timestamp:1792283400,slot:123,tokenTransfers:[]};

try{
  assert.equal(enabled({}),false);
  assert.equal(enabled({BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED:"1"}),false);
  assert.equal(enabled({BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED:"true"}),true);
  db.exec(`CREATE TABLE chain_seed_events (
    kind TEXT NOT NULL,address TEXT NOT NULL,signature TEXT NOT NULL,
    block_time INTEGER,slot INTEGER,payload_gzip BLOB NOT NULL,
    payload_bytes INTEGER NOT NULL,observed_at INTEGER NOT NULL,
    payload_hash TEXT,raw_revision INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(kind,address,signature)
  )`);
  ensureSchema(db);
  process.env.BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED="true";
  assert.throws(()=>db.transaction(()=>{
    persistEvents(db,"wallet",wallet,[tx]);
    throw new Error("forced outer transaction abort");
  })(),/forced outer transaction abort/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM chain_seed_events").get().n,0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM outbox_events").get().n,0,
    "source and outbox must roll back atomically");
  assert.equal(persistEvents(db,"wallet",wallet,[tx]),1);
  assert.equal(persistEvents(db,"wallet",wallet,[tx]),0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM outbox_events").get().n,1,
    "replay does not create a second revision");
  assert.equal(persistEvents(db,"wallet",wallet,[{...tx,slot:124}]),1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM outbox_events").get().n,2,
    "changed raw evidence creates a new immutable revision");
  assert.equal(db.prepare("SELECT raw_revision FROM chain_seed_events").get().raw_revision,2);
  const event=db.prepare("SELECT payload FROM outbox_events ORDER BY id LIMIT 1").get();
  const body=JSON.parse(event.payload);
  assert.deepEqual(body.registryEvent.entityRefs.map(x=>x.kind),["wallet"]);
  assert.equal(body.registryEvent.evidenceRef.sourceId,"chain:tx:solana:"+signature);
  assert.equal(body.timelineEvent.kind,"chain_transaction");
  assert.ok(!event.payload.includes("tokenTransfers"));
  assert.equal(persistEvents(db,"token",wallet,[{...tx,signature:"2".repeat(64)}]),1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM outbox_events").get().n,2,
    "a mere token-target address is not proof of an actual mint");
  assert.throws(()=>buildWalletRawEvent({
    kind:"wallet",address:wallet,signature:"abc",payloadHash:"a".repeat(64),
    observedAt:Date.now(),
  }),/signature/);
  assert.equal(buildWalletRawEvent({
    kind:"creator",address:wallet,signature:"bad",payloadHash:"a".repeat(64),
    observedAt:Date.now(),
  }),null);
  console.log("blockchain Intelligence outbox SQLite contract PASS");
} finally {
  if(old===undefined)delete process.env.BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED;
  else process.env.BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED=old;
  db.close();
}
