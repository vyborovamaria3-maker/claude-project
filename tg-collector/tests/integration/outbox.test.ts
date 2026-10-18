import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {persistMessage,markMessageDeleted} from "../../src/persistence/messages.js";

test("TG PostgreSQL: page transaction commits message, revision and delete outbox atomically",{
  skip:!process.env.DATABASE_URL,
},async()=>{
  const {pool,migrate}=await import("../../src/db.js");
  await migrate();
  const client=await pool.connect();
  const old=process.env.TG_INTELLIGENCE_OUTBOX_ENABLED;
  process.env.TG_INTELLIGENCE_OUTBOX_ENABLED="true";
  const peer="123456789";
  const identifier="outbox_test_"+randomUUID().replaceAll("-","").slice(0,22);
  let rolledBack=false;
  try {
    await client.query("BEGIN");
    const source=await client.query<{id:string}>(
      "INSERT INTO tg_sources(identifier,peer_id) VALUES($1,$2) RETURNING id::text",
      [identifier,peer]);
    const id=source.rows[0]!.id;
    const base={id:52,date:1792283400,message:"public solana address: So11111111111111111111111111111111111111112",
      views:12};
    await persistMessage(client,id,base);
    await persistMessage(client,id,base);
    const again=await client.query<{n:string}>(
      "SELECT count(*)::text AS n FROM outbox_events WHERE source_system='tg' AND event_kind='message_observed'");
    assert.equal(again.rows[0]?.n,"1","replay cannot duplicate identical revision");
    await persistMessage(client,id,{...base,message:"edited",views:15});
    const changed=await client.query<{n:string}>(
      "SELECT count(*)::text AS n FROM outbox_events WHERE source_system='tg' AND event_kind='message_observed'");
    assert.equal(changed.rows[0]?.n,"2","new revision creates a distinct event");
    assert.equal(await markMessageDeleted(client,id,52),true);
    assert.equal(await markMessageDeleted(client,id,52),false);
    const deleted=await client.query<{n:string}>(
      "SELECT count(*)::text AS n FROM outbox_events WHERE source_system='tg' AND event_kind='message_deleted'");
    assert.equal(deleted.rows[0]?.n,"1");
    await persistMessage(client,id,{...base,message:"restored"});
    assert.equal(await markMessageDeleted(client,id,52),true);
    const deletedTwice=await client.query<{n:string}>(
      "SELECT count(*)::text AS n FROM outbox_events WHERE source_system='tg' AND event_kind='message_deleted'");
    assert.equal(deletedTwice.rows[0]?.n,"2","a second deletion after restoring must have its own evidence revision");
    const payloads=await client.query<{payload:{registryEvent:{entityRefs:{kind:string}[]}}}>(
      "SELECT payload FROM outbox_events WHERE source_system='tg' ORDER BY id");
    assert.equal(payloads.rows.length,5);
    assert.ok(payloads.rows.every(row=>
      row.payload.registryEvent.entityRefs.every(entity=>entity.kind==="source")));
    await client.query("ROLLBACK");rolledBack=true;
    const absent=await client.query<{n:string}>(
      "SELECT count(*)::text AS n FROM outbox_events WHERE event_key LIKE 'tg:123456789:52:%'");
    assert.equal(absent.rows[0]?.n,"0","ROLLBACK removes messages and corresponding outbox revisions");
  } finally {
    if (!rolledBack) {try{await client.query("ROLLBACK")}catch{}}
    if(old===undefined) delete process.env.TG_INTELLIGENCE_OUTBOX_ENABLED;
    else process.env.TG_INTELLIGENCE_OUTBOX_ENABLED=old;
    client.release();
    await pool.end();
  }
});
