import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import Database from "better-sqlite3";
import {SQLITE_OUTBOX_DDL} from "@claude-project/event-outbox";
import {
  parseBackfillArgs,buildXSnapshotEvent,buildTgSnapshotEvent,
  checkpointFor,validateCheckpoint,advanceCheckpoint,readCheckpoint,
  writeCheckpoint,withExclusiveCheckpointLock,validateRawChainEvidence,
} from "../scripts/backfill-core.mjs";
import {
  processSqlitePage,readHighWater,validateBackfillGate,
} from "../scripts/backfill.mjs";

test("backfill CLI defaults to dry-run, refuses unsafe sources and unbounded writes",()=>{
  assert.deepEqual(parseBackfillArgs(["--source","x","--limit","25"]),{
    source:"x",limit:25,execute:false,scope:null,checkpoint:null,help:false,
  });
  for(const args of [
    [],["--source","tiktoks"],["--source","x","--source","tg"],
    ["--source","tg","--limit","0"],["--source","tg","--limit","101"],
    ["--source","tg","--execute"],["--source","tg","--execute","--scope","db"],
    ["--source","x","--execute","--scope","my-db","--checkpoint",""],
  ])assert.throws(()=>parseBackfillArgs(args));
  const write=parseBackfillArgs(["--source","x","--execute","--scope","my-db",
    "--checkpoint","./source-checkpoint.json"]);
  assert.throws(()=>validateBackfillGate(write,{}),/explicit_backfill_opt_in_required/);
  assert.doesNotThrow(()=>validateBackfillGate(write,{
    INTELLIGENCE_BACKFILL_ENABLED:"true",INTELLIGENCE_BACKFILL_WRITE_ENABLED:"true",
  }));
});

test("X snapshot cannot fake earlier firstSeenAt or token link: only latest timestamp + author",()=>{
  const e=buildXSnapshotEvent({
    tweet_id:"9007199254740993000",author_id:"345678901234567890",
    text:"private source text",updated_at:"1792461000000",
    first_seen_at:"1500000000000",posted_at:"1700000000000",
  });
  assert.equal(e.payload.registryEvent.evidenceRef.observedAt,
    new Date(1792461000000).toISOString());
  assert.equal(e.payload.registryEvent.evidenceRef.occurredAt,
    new Date(1700000000000).toISOString());
  assert.deepEqual(e.payload.registryEvent.entityRefs.map(r=>r.kind),["author"]);
  assert.ok(!JSON.stringify(e).includes("private source text"));
  assert.equal(buildXSnapshotEvent({tweet_id:"10",author_id:null,updated_at:123,posted_at:null}),null);
  assert.equal(buildXSnapshotEvent({tweet_id:"0",author_id:"123",updated_at:123,posted_at:null}),null);
  assert.throws(()=>buildXSnapshotEvent({
    tweet_id:"12",author_id:"123",updated_at:"not-a-time",posted_at:null,
  }));
});

test("TG snapshot uses latest collected_at, excludes deleted or peerless messages",()=>{
  const row={source_id:"1",message_id:"40",peer_id:"12345",
    collected_at:new Date("2026-10-19T23:50:00Z"),
    posted_at:new Date("2026-10-10T01:00:00Z"),
    deleted_at:null,text:"Private TG content"};
  const result=buildTgSnapshotEvent(row);
  assert.equal(result.payload.registryEvent.evidenceRef.observedAt,"2026-10-19T23:50:00.000Z");
  assert.equal(result.payload.registryEvent.evidenceRef.occurredAt,"2026-10-10T01:00:00.000Z");
  assert.equal(result.payload.registryEvent.entityRefs[0].canonicalId,"tg:source:12345");
  assert.ok(!JSON.stringify(result).includes("Private TG content"));
  assert.ok(!result.payload.registryEvent.entityRefs.some(r=>r.kind==="token"));
  assert.equal(buildTgSnapshotEvent({...row,peer_id:null}),null);
  assert.equal(buildTgSnapshotEvent({...row,deleted_at:new Date()}),null);
});

test("checkpoint persists without raw content; exclusive lock, validation and replay cursor",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"arch08-checkpoint-"));
  const path=join(dir,"tg.json");
  try{
    const high={sourceId:"100",messageId:"500"};
    const initial=checkpointFor("tg","my-verified-db",high);
    assert.equal(initial.complete,false);
    await writeCheckpoint(path,initial);
    assert.deepEqual(await readCheckpoint(path,"tg","my-verified-db"),initial);
    await assert.rejects(readCheckpoint(path,"x","my-verified-db"));
    let once=false;
    await withExclusiveCheckpointLock(path,async()=>{
      await assert.rejects(withExclusiveCheckpointLock(path,async()=>{}),error=>error.code==="EEXIST");
      once=true;
    });
    assert.equal(once,true);
    const next=advanceCheckpoint(initial,[{source_id:"1",message_id:"30"}],{
      inserted:1,duplicates:0,excluded:0,
    },"tg");
    assert.equal(next.cursor.messageId,"30");
    assert.equal(next.visited,1);
    await writeCheckpoint(path,next);
    assert.equal((await readCheckpoint(path,"tg","my-verified-db")).cursor.messageId,"30");
    assert.equal((await readFile(path,"utf8")).includes("password"),false);
    assert.throws(()=>validateCheckpoint({...next,scope:"different"},"tg","my-verified-db"));
    const completed=advanceCheckpoint(next,[],{inserted:0,duplicates:0,excluded:0},"tg");
    assert.equal(completed.complete,true);
  }finally{await rm(dir,{recursive:true,force:true})}
});

const address="11111111111111111111111111111111"; // valid 32-byte Solana pubkey
const signature="1".repeat(64+1); // one leading zero byte + 64? rejected by native base58 count
const validSignature="2".repeat(87); // validate at build time in test

test("Blockchain replay uses exact wallet raw hash and refuses null hash instead of guessing",()=>{
  const db=new Database(":memory:");
  try{
    db.exec(SQLITE_OUTBOX_DDL);
    db.exec("CREATE TABLE chain_seed_events(kind TEXT,address TEXT,signature TEXT,block_time INTEGER,observed_at INTEGER,payload_hash TEXT)");
    const mk=(n,hash)=>db.prepare(
      "INSERT INTO chain_seed_events VALUES(?,?,?,?,?,?)").run("wallet",address,n,
      1700000000,1792461000000,hash);
    // The all-ones signature decodes to exactly 64 zero bytes.
    const sig="1".repeat(64);
    mk(sig,"a".repeat(64));
    assert.equal(readHighWater("blockchain",db) instanceof Promise,true);
    const high={address,signature:sig};
    const state=checkpointFor("blockchain","solana-fixture-db",high);
    const dry=processSqlitePage(db,state,20,false);
    assert.equal(dry.rows.length,1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM outbox_events").get().n,0);
    const first=processSqlitePage(db,state,20,true);
    assert.equal(first.stats.inserted,1);
    const replay=processSqlitePage(db,state,20,true);
    assert.equal(replay.stats.duplicates,1);
    const payload=JSON.parse(db.prepare("SELECT payload FROM outbox_events").get().payload);
    assert.equal(payload.registryEvent.evidenceRef.parserVersion,"chain-seed-v1");
    assert.ok(!JSON.stringify(payload).includes("payload_gzip"));
    db.prepare("UPDATE chain_seed_events SET payload_hash=NULL").run();
    assert.throws(()=>validateRawChainEvidence({
      kind:"wallet",observed_at:1792461000000,block_time:1700000000,payload_hash:null,
    }));
    assert.throws(()=>processSqlitePage(db,state,20,true));
    assert.equal(db.prepare("SELECT count(*) AS n FROM outbox_events").get().n,1);
  }finally{db.close();}
});

test("signed native Telegram peer ID is preserved during snapshot backfill",()=>{
  const event=buildTgSnapshotEvent({
    source_id:"3",message_id:"42",peer_id:"-100123456789",
    collected_at:new Date("2026-10-20T01:00:00Z"),
    posted_at:new Date("2026-10-19T01:00:00Z"),
    deleted_at:null,text:"message with no verified token evidence",
  });
  assert.equal(event.payload.registryEvent.entityRefs[0].canonicalId,
    "tg:source:-100123456789");
  assert.equal(event.payload.registryEvent.evidenceRef.sourceId,
    "tg:message:-100123456789:42");
  assert.equal(event.payload.registryEvent.entityRefs.length,1);
});
