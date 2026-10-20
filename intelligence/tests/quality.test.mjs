import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes} from "node:crypto";
import pg from "pg";
import Database from "better-sqlite3";
import {POSTGRES_OUTBOX_DDL,SQLITE_OUTBOX_DDL} from "@claude-project/event-outbox";
import {checkpointFor,writeCheckpoint} from "../scripts/backfill-core.mjs";
import {
  parseQualityArgs,normalizeOutboxCounters,inspectSourceSamples,
  loadCheckpointSummary,sourceHealth,formatQualityTable,
} from "../scripts/quality-core.mjs";
import {readSourceQuality,readDestinationQuality,collectQuality} from "../scripts/quality.mjs";
import {readFile} from "node:fs/promises";

const cli=fileURLToPath(new URL("../scripts/quality.mjs",import.meta.url));
const cwd=fileURLToPath(new URL("..",import.meta.url));
const at=new Date("2026-10-20T02:00:00Z");

test("quality CLI help is credentialless and offline",()=>{
  const proc=spawnSync(process.execPath,[cli,"--help"],{
    cwd,encoding:"utf8",env:{PATH:process.env.PATH,HOME:process.env.HOME},
  });
  assert.equal(proc.status,0,proc.stderr);
  assert.match(proc.stdout,/read-only/);
  assert.match(proc.stdout,/historical|history completeness/i);
});

test("quality option parser fail-closes on malformed sources, checkpoints and budgets",()=>{
  assert.deepEqual(parseQualityArgs(["--sources","tg","--format","table","--sample=10","--target"]),{
    sources:["tg"],sample:10,staleMinutes:60,target:true,strict:false,
    format:"table",checkpoints:{},help:false,
  });
  for(const flags of [
    ["--sources","x,x"],["--sources","tg,unknown"],["--sample","0"],
    ["--sample","1001"],["--stale-minutes","1441"],["--format","html"],
    ["--sources","x","--checkpoint","tg=/tmp/bad"],["--checkpoint","bad"],
    ["--source","x"],["--strict=true"],["--sample","nope"],["--sample","5","--sample","3"],
  ])assert.throws(()=>parseQualityArgs(flags),Error);
  const windows=parseQualityArgs(["--sources","x","--checkpoint","x=C:\\Data\\report.json"]);
  assert.equal(windows.checkpoints.x,"C:\\Data\\report.json");
});

test("source quality classification distinguishes sample exclusions from history completeness",()=>{
  const sample=inspectSourceSamples("x",[
    {tweet_id:"101",author_id:"900",updated_at:1792461000000},
    {tweet_id:"102",author_id:null,updated_at:1792461000000},
    {tweet_id:"103",author_id:"bad",updated_at:1792461000000},
  ]);
  assert.equal(sample.examined,3);
  assert.equal(sample.candidateEligible,1);
  assert.equal(sample.excluded,2);
  assert.equal(sample.reasons.missingStableAuthorId,2);
  assert.equal(sample.historicalCoverage,"unknown");
  const tg=inspectSourceSamples("tg",[
    {peer_id:"12345",message_id:"2",deleted_at:null,collected_at:at},
    {peer_id:null,message_id:"3",deleted_at:null,collected_at:at},
    {peer_id:"12345",message_id:"4",deleted_at:at,collected_at:at},
  ]);
  assert.equal(tg.candidateEligible,1);
  assert.equal(tg.reasons.deletedSnapshot,1);
  const chain=inspectSourceSamples("blockchain",[
    {kind:"wallet",address:"1".repeat(32),signature:"1".repeat(64),
      payload_hash:"a".repeat(64),observed_at:1792461000000},
    {kind:"wallet",address:"1".repeat(32),signature:"1".repeat(64),
      payload_hash:null,observed_at:1792461000000},
  ]);
  assert.equal(chain.candidateEligible,1);
  assert.equal(chain.reasons.missingRawPayloadHash,1);
});

test("queue age/overlapping counts and alert thresholds stay explicit",()=>{
  const raw={
    total:"5",pending:"2",ready:"1",leased:"1",retry_delayed:"1",
    dead_letter:"1",processed:"2",verified_links:"1",invalidations:"1",
    oldest_pending_at:"2026-10-20T00:30:00Z",
  };
  const n=normalizeOutboxCounters(raw,at,60);
  assert.equal(n.oldestPendingMinutes,90);
  assert.equal(n.stale,true);
  assert.equal(n.countsConsistent,true);
  assert.equal(n.deadLetter,1);
  assert.equal(sourceHealth({status:"ok",queue:n,sample:{excluded:0}}),"attention");
  const malformed=normalizeOutboxCounters({...raw,total:"9"},at,60);
  assert.equal(malformed.countsConsistent,false);
  assert.throws(()=>normalizeOutboxCounters({...raw,pending:"18446744073709551616"},at,60));
});

test("checkpoint quality audit rejects wrong database identity without revealing file path",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"arch09-q-"));
  const path=join(dir,"safe.json"),identity="a".repeat(64);
  try{
    await writeCheckpoint(path,checkpointFor("x","local-x-test",{len:2,id:"99"},identity));
    const report=await loadCheckpointSummary(path,"x",identity);
    assert.equal(report.state,"verified_for_database");
    assert.equal(report.boundedScanComplete,false);
    assert.equal(report.historyCompleteness,"unknown");
    await assert.rejects(loadCheckpointSummary(path,"x","b".repeat(64)));
    assert.ok(!(await readFile(path,"utf8")).includes("password"));
  }finally{await rm(dir,{force:true,recursive:true});}
});

test("offline SQLite queue and evidence sample: no writes, no false complete status",async()=>{
  const db=new Database(":memory:");
  try{
    db.exec(SQLITE_OUTBOX_DDL);
    db.exec("CREATE TABLE chain_seed_events(kind TEXT,address TEXT,signature TEXT,observed_at INTEGER,payload_hash TEXT)");
    db.prepare("INSERT INTO chain_seed_events VALUES(?,?,?,?,?)").run(
      "wallet","1".repeat(32),"1".repeat(64),1792461000000,"f".repeat(64));
    db.prepare("INSERT INTO outbox_events "+
      "(source_system,event_kind,event_key,schema_version,payload,created_at,next_attempt_at) "+
      "VALUES(?,?,?,?,?,?,?)").run(
        "blockchain","wallet_transaction_observed","fixture-1","fixture-v1",
        "{}","2026-10-20T00:00:00Z","2026-10-20T00:00:00Z");
    const options=parseQualityArgs(["--sources","blockchain","--sample","10"]);
    const connection={kind:"sqlite",connection:db,close:async()=>{}};
    const observed=await collectQuality(options,{
      connections:{blockchain:connection},now:at,
    });
    assert.equal(observed.status,"attention");
    assert.equal(observed.sources.blockchain.queue.total,1);
    assert.equal(observed.sources.blockchain.queue.ready,1);
    assert.equal(observed.sources.blockchain.queue.oldestPendingMinutes,120);
    assert.equal(observed.sources.blockchain.sample.candidateEligible,1);
    assert.equal(observed.historicalCompleteness,"unknown");
    assert.match(formatQualityTable(observed),/History completeness: UNKNOWN/);
    assert.equal(db.prepare("SELECT count(*) n FROM outbox_events").get().n,1);
  }finally{db.close()}
});

test("unavailable source or wrong target cannot produce healthy green report",async()=>{
  const opts=parseQualityArgs(["--sources","x","--target"]);
  const report=await collectQuality(opts,{
    connections:{x:{kind:"pg",connection:{query:async()=>{throw new Error("postgres://pw=secret")}}}},
    destination:{query:async()=>{throw new Error("secret DB DSN")}},
    now:at,
  });
  assert.equal(report.status,"unavailable");
  assert.equal(report.sources.x.status,"unavailable");
  assert.equal(report.destination.status,"unavailable");
  assert.ok(!JSON.stringify(report).includes("secret"));
  assert.ok(!JSON.stringify(report).includes("postgres://"));
});

test("real temporary PostgreSQL sources + destination counters remain separate from history coverage",{
  skip:!process.env.INTELLIGENCE_TEST_DB_URL,
},async()=>{
  const url=process.env.INTELLIGENCE_TEST_DB_URL;
  const suffix=randomBytes(5).toString("hex");
  const schemas={x:"quality_x_"+suffix,tg:"quality_tg_"+suffix,
    dst:"quality_dst_"+suffix};
  const admin=new pg.Client({connectionString:url});
  const pools={};
  await admin.connect();
  try{
    for(const s of Object.values(schemas))await admin.query('CREATE SCHEMA "'+s+'"');
    await admin.query('SET search_path TO "'+schemas.x+'"');
    await admin.query("CREATE TABLE twitter_tweets(tweet_id TEXT PRIMARY KEY,author_id TEXT,updated_at BIGINT,posted_at BIGINT)");
    await admin.query(POSTGRES_OUTBOX_DDL);
    await admin.query("INSERT INTO twitter_tweets VALUES('101','222',1792461000000,1700000000000),"+
      "('102',NULL,1792461000000,1700000000000)");
    await admin.query("INSERT INTO outbox_events(source_system,event_kind,event_key,schema_version,payload,created_at,next_attempt_at) "+
      "VALUES('x','tweet_observed','quality-1','q1','{}',NOW()-interval '2 hour',NOW()-interval '2 hour')");
    await admin.query('SET search_path TO "'+schemas.tg+'"');
    await admin.query("CREATE TABLE tg_sources(id BIGINT PRIMARY KEY,peer_id TEXT)");
    await admin.query("CREATE TABLE tg_messages(source_id BIGINT,message_id BIGINT,collected_at TIMESTAMPTZ,deleted_at TIMESTAMPTZ)");
    await admin.query(POSTGRES_OUTBOX_DDL);
    await admin.query("INSERT INTO tg_sources VALUES(1,'444')");
    await admin.query("INSERT INTO tg_messages VALUES(1,1,NOW(),NULL),(1,2,NOW(),NOW())");
    await admin.query('SET search_path TO "'+schemas.dst+'"');
    for(const file of ["001_entity_registry.sql","002_timeline.sql","004_token_link_observations.sql"]){
      await admin.query(await readFile(new URL("../migrations/"+file,import.meta.url),"utf8"));
    }
    for(const [name,schema] of Object.entries(schemas)){
      pools[name]=new pg.Pool({connectionString:url,options:"-c search_path="+schema,max:3});
    }
    const settings=parseQualityArgs(["--sources","x,tg","--sample","10","--target"]);
    const observed=await collectQuality(settings,{
      connections:{x:{kind:"pg",connection:pools.x},tg:{kind:"pg",connection:pools.tg}},
      destination:pools.dst,now:new Date(),
    });
    assert.equal(observed.status,"attention");
    assert.equal(observed.sources.x.queue.pending,1);
    assert.equal(observed.sources.x.queue.oldestPendingMinutes>=119,true);
    assert.equal(observed.sources.x.sample.reasons.missingStableAuthorId,1);
    assert.equal(observed.sources.tg.sample.reasons.deletedSnapshot,1);
    assert.equal(observed.destination.status,"ok");
    assert.equal(observed.destination.sources.x.ingested,0);
    assert.equal(observed.destination.sources.tg.timeline,0);
    assert.equal(observed.destination.migration004,true);
    assert.equal(observed.historicalCompleteness,"unknown");
  }finally{
    for(const pool of Object.values(pools))await pool.end();
    for(const s of Object.values(schemas).reverse()){
      try{await admin.query('DROP SCHEMA IF EXISTS "'+s+'" CASCADE')}catch{}
    }
    await admin.end();
  }
});
