import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import Database from "better-sqlite3";
import {SQLITE_OUTBOX_DDL} from "@claude-project/event-outbox";
import {fileURLToPath} from "node:url";

const cwd=fileURLToPath(new URL("..",import.meta.url));
const cli=fileURLToPath(new URL("../scripts/run.mjs",import.meta.url));
const child=(args,env={})=>spawnSync(process.execPath,[cli,...args],{
  cwd,encoding:"utf8",
  env:{PATH:process.env.PATH,HOME:process.env.HOME,...env},
});
test("CLI --help does not open any provider or DB",()=>{
  const r=child(["--help"]);
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/local ETL/);
  assert.match(r.stdout,/--source x\|tg\|blockchain/);
});
test("CLI delivery refuses missing explicit opt-in",()=>{
  const r=child(["--source","tg","--once"]);
  assert.equal(r.status,1);
  assert.match(r.stderr,/INTELLIGENCE_ETL_ENABLED=true/);
});
test("CLI invalid options fail without database credentials",()=>{
  for(const args of [["--source","x","--once","--limit","0"],["--source","reddit","--status"],["--source","tg","--once","--status"]]) {
    const r=child(args);
    assert.equal(r.status,1);
    assert.doesNotMatch(r.stderr,/postgres:\/\//);
  }
});

test("SQLite status audits pending/ready/delayed/leased/DLQ without changing source rows",()=>{
  const root=mkdtempSync(join(tmpdir(),"etl-status-"));
  const filename=join(root,"fixture.sqlite");
  const db=new Database(filename);
  try{
    db.exec(SQLITE_OUTBOX_DDL);
    const insert=db.prepare(`INSERT INTO outbox_events
      (source_system,event_kind,event_key,schema_version,payload,created_at,next_attempt_at,attempts,lease_owner,lease_until,dead_lettered_at)
      VALUES('blockchain','fixture',?,'v1','{}',?,?,?,?,?,?)`);
    const old="2020-01-01T00:00:00.000Z",far="2999-01-01T00:00:00.000Z";
    insert.run("ready",old,old,0,null,null,null);
    insert.run("retry",old,far,2,null,null,null);
    insert.run("leased",old,old,1,"active",far,null);
    insert.run("dead",old,old,12,null,null,old);
    const before=db.prepare("SELECT count(*) AS n FROM outbox_events").get().n;
    db.close();
    const run=child(["--source","blockchain","--status"],{
      SOLANA_TRADE_DB_PATH:filename,
    });
    assert.equal(run.status,0,run.stderr);
    const stats=JSON.parse(run.stdout);
    assert.equal(stats.pending,3);
    assert.equal(stats.ready,1);
    assert.equal(stats.retryDelayed,1);
    assert.equal(stats.leased,1);
    assert.equal(stats.deadLetter,1);
    assert.equal(stats.maxAttempts,2);
    assert.equal(stats.oldestPendingAt,old);
    const verify=new Database(filename,{readonly:true,fileMustExist:true});
    try{assert.equal(verify.prepare("SELECT count(*) AS n FROM outbox_events").get().n,before)}
    finally{verify.close()}
  }finally{if(db.open)db.close();rmSync(root,{recursive:true,force:true})}
});
