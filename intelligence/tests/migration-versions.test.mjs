import test from "node:test";
import assert from "node:assert/strict";
import {readdir,readFile} from "node:fs/promises";
const root=new URL("../migrations/",import.meta.url);
test("SQL migrations have unique sequential version numbers",async()=>{
  const names=(await readdir(root)).filter(n=>/^\d{3}_.*\.sql$/.test(n)).sort();
  const byVersion=new Map();
  for(const name of names){
    const prefix=Number(name.slice(0,3));
    assert.ok(!byVersion.has(prefix),
      "duplicate migration version "+prefix+" in "+byVersion.get(prefix)+" and "+name);
    byVersion.set(prefix,name);
  }
  for(let n=1;n<=14;n++)assert.ok(byVersion.has(n),
    "missing migration "+String(n).padStart(3,"0"));
  const privacy=await readFile(new URL("014_privacy_evidence_indexes.sql",root),"utf8");
  assert.match(privacy,/idx_intelligence_inbox_evidence_source/);
  const retries=await readFile(new URL("013_invalidation_retry_schedule.sql",root),"utf8");
  assert.match(retries,/next_attempt_at/);
});
