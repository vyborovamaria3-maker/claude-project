import test from "node:test";
import assert from "node:assert/strict";
import type {PoolClient} from "pg";
import {activeMintOccurrences} from "../src/analytics/token-candidate-occurrences.js";

test("integrated RPC occurrence query retains peer/revision provenance and confirmed-current scope",async()=>{
  let sql="",values:unknown[]=[];
  const tx={query:async(text:string,args:unknown[])=>{
    sql=text;values=args;return {rows:[{source_id:"1",message_id:"911",peer_id:"-100123",edited_at:null}]};
  }} as unknown as PoolClient;
  const rows=await activeMintOccurrences(tx,"synthetic-mint");
  assert.equal(rows.rows[0].peer_id,"-100123");
  assert.match(sql,/JOIN tg_sources s ON s.id=c.source_id/);
  assert.match(sql,/s.peer_id::text AS peer_id,m.edited_at/);
  assert.match(sql,/c.resolution_status='confirmed_token'/);
  assert.match(sql,/c.analysis_version=\$3/);
  assert.match(sql,/m.deleted_at IS NULL/);
  assert.equal(values[1],"synthetic-mint");
});
