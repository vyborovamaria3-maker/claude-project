import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
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
