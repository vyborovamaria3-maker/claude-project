import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Pool} from "pg";

const connectionString=process.env.INTELLIGENCE_TEST_DB_URL;

test("Discord contract migration widens only evidence and timeline constraints, idempotently", {
  skip: !connectionString,
}, async()=>{
  const pool=new Pool({connectionString});
  const client=await pool.connect();
  const schema="discord_contract_test_"+process.pid;
  try{
    await client.query('CREATE SCHEMA "'+schema+'"');
    await client.query('SET search_path TO "'+schema+'"');
    for(const name of ["001_entity_registry.sql","002_timeline.sql","022_discord_message_contracts.sql"]){
      const sql=await readFile(new URL("../migrations/"+name,import.meta.url),"utf8");
      await client.query(sql);
    }
    // A replay must be a no-op, not a duplicate-constraint failure.
    const migration=await readFile(new URL("../migrations/022_discord_message_contracts.sql",import.meta.url),"utf8");
    await client.query(migration);

    const guild="12345678901234567",channel="22345678901234567",message="32345678901234567";
    const sourceId="discord:message:"+guild+":"+channel+":"+message;
    const eventKey="discord-fixture-observed";
    await client.query(
      "INSERT INTO intelligence_inbox(source_system,event_kind,event_key,schema_version,evidence_source_id) VALUES($1,$2,$3,$4,$5)",
      ["discord","discord_message_observed",eventKey,"discord-message-v1",sourceId]);
    await client.query(
      "INSERT INTO entity_registry(kind,canonical_id,first_seen_at,last_seen_at) VALUES('source',$1,NOW(),NOW())",
      ["discord:channel:"+channel]);
    await client.query(
      "INSERT INTO entity_evidence(source_system,event_kind,event_key,kind,canonical_id,evidence_source_id,evidence_kind,observed_at,occurred_at,parser_version) VALUES($1,$2,$3,'source',$4,$5,'discord_message',NOW(),NOW(),'fixture-v1')",
      ["discord","discord_message_observed",eventKey,"discord:channel:"+channel,sourceId]);
    await client.query(
      "INSERT INTO timeline_events(source_system,source_event_kind,event_key,timeline_kind,occurred_at,observed_at,evidence_source_id,schema_version,payload) VALUES($1,$2,$3,'discord_message_observed',NOW(),NOW(),$4,'timeline-v1','{}'::jsonb)",
      ["discord","discord_message_observed",eventKey,sourceId]);
    await client.query(
      "INSERT INTO timeline_event_entities(source_system,source_event_kind,event_key,kind,canonical_id) VALUES($1,$2,$3,'source',$4)",
      ["discord","discord_message_observed",eventKey,"discord:channel:"+channel]);
    const counts=await client.query(
      "SELECT (SELECT count(*) FROM entity_evidence WHERE evidence_kind='discord_message') AS evidence_count,"+
      "(SELECT count(*) FROM timeline_events WHERE timeline_kind='discord_message_observed') AS timeline_count");
    assert.equal(Number(counts.rows[0].evidence_count),1);
    assert.equal(Number(counts.rows[0].timeline_count),1);
    await assert.rejects(
      client.query("INSERT INTO entity_evidence(source_system,event_kind,event_key,kind,canonical_id,evidence_source_id,evidence_kind,observed_at) VALUES('discord','bad','bad','source',$1,$2,'unknown_kind',NOW())",
        ["discord:channel:"+channel,sourceId]),
      /check constraint/i,
    );
  }finally{
    try{await client.query("SET search_path TO public");await client.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');}
    finally{client.release();await pool.end();}
  }
});
