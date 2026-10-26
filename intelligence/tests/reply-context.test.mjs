import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readCollectorContext} from '../dist/index.js';

const url=process.env.INTELLIGENCE_TEST_DB_URL;
const at='2026-10-20T12:00:00.000Z',targetAt='2026-10-20T11:59:00.000Z';
const ref='tg:message:-100123:20';
async function fixture(t,{legacy=false}={}){
 const schema='reply_context_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:url});
 await admin.query('CREATE SCHEMA '+schema);
 const source=new pg.Pool({connectionString:url,options:'-c search_path='+schema,max:2});
 t.after(async()=>{await source.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();});
 await source.query(`CREATE TABLE tg_sources(id BIGINT PRIMARY KEY,peer_id TEXT);
  CREATE TABLE tg_messages(source_id BIGINT,message_id BIGINT,text TEXT,collected_at TIMESTAMPTZ,
   posted_at TIMESTAMPTZ,deleted_at TIMESTAMPTZ,edited_at TIMESTAMPTZ${legacy?'':',reply_to_message_id BIGINT'},
   PRIMARY KEY(source_id,message_id));
  INSERT INTO tg_sources VALUES(1,'-100123'),(2,'-100456');`);
 await source.query(`INSERT INTO tg_messages(source_id,message_id,text,collected_at,posted_at) VALUES
  (1,1,'Actual bearish parent, two hours earlier',$1,'2026-10-20T10:00:00Z'),
  (1,18,'Unrelated token A is rising',$1,'2026-10-20T11:57:00Z'),
  (1,19,'Unrelated token B is rising',$1,'2026-10-20T11:58:00Z'),
  (1,20,'If that happened I would be rich',$1,$2),
  (2,1,'Foreign source with the same message ID',$1,'2026-10-20T10:00:00Z')`,[targetAt,targetAt]);
 if(!legacy)await source.query('UPDATE tg_messages SET reply_to_message_id=1 WHERE source_id=1 AND message_id=20');
 return source;
}

test('TG reply context retains the exact same-source parent older than the neighbor window',{skip:!url},async t=>{
 const source=await fixture(t),context=await readCollectorContext(source,'tg',ref,at);
 assert.deepEqual(context.map(row=>row.evidenceRef),['tg:message:-100123:1']);
 assert.equal(context[0].text,'Actual bearish parent, two hours earlier');
 assert.ok(context[0].postedAt<new Date(Date.parse(targetAt)-30*60*1000).toISOString());
});
test('unavailable or unsafe declared TG parents never fall back to unrelated neighbors',{skip:!url},async t=>{
 const source=await fixture(t);
 const cases=[
  ['missing parent',"UPDATE tg_messages SET reply_to_message_id=2 WHERE source_id=1 AND message_id=20"],
  ['deleted parent',"UPDATE tg_messages SET deleted_at='2026-10-20T11:00:00Z' WHERE source_id=1 AND message_id=1"],
  ['parent first observed after cutoff',"UPDATE tg_messages SET collected_at='2026-10-20T12:00:01Z' WHERE source_id=1 AND message_id=1"],
  ['parent edited after cutoff',"UPDATE tg_messages SET edited_at='2026-10-20T12:00:01Z' WHERE source_id=1 AND message_id=1"],
  ['parent posted after target',"UPDATE tg_messages SET posted_at='2026-10-20T11:59:01Z' WHERE source_id=1 AND message_id=1"],
  ['parent beyond text bound',"UPDATE tg_messages SET text=repeat('x',1201) WHERE source_id=1 AND message_id=1"],
  ['filtered parent',"UPDATE tg_messages SET text='Gamble Found! card' WHERE source_id=1 AND message_id=1"],
  ['parent with a later message ID',"UPDATE tg_messages SET reply_to_message_id=30 WHERE source_id=1 AND message_id=20; UPDATE tg_messages SET message_id=30 WHERE source_id=1 AND message_id=1"],
  ['deleted target',"UPDATE tg_messages SET deleted_at='2026-10-20T11:59:30Z' WHERE source_id=1 AND message_id=20"],
  ['target first observed after cutoff',"UPDATE tg_messages SET collected_at='2026-10-20T12:00:01Z' WHERE source_id=1 AND message_id=20"],
  ['target edited after cutoff',"UPDATE tg_messages SET edited_at='2026-10-20T12:00:01Z' WHERE source_id=1 AND message_id=20"],
  ['target posted after cutoff',"UPDATE tg_messages SET posted_at='2026-10-20T12:00:01Z' WHERE source_id=1 AND message_id=20"],
 ];
 for(const [name,sql] of cases)await t.test(name,async()=>{
  await source.query(`UPDATE tg_messages SET message_id=1 WHERE source_id=1 AND message_id=30;
   UPDATE tg_messages SET text='Actual bearish parent, two hours earlier',collected_at='2026-10-20T11:59:00Z',
    posted_at='2026-10-20T10:00:00Z',deleted_at=NULL,edited_at=NULL WHERE source_id=1 AND message_id=1;
   UPDATE tg_messages SET reply_to_message_id=1,collected_at='2026-10-20T11:59:00Z',
    posted_at='2026-10-20T11:59:00Z',deleted_at=NULL,edited_at=NULL WHERE source_id=1 AND message_id=20;`);
  await source.query(sql);
  assert.deepEqual(await readCollectorContext(source,'tg',ref,at),[]);
 });
});
test('legacy TG schema without reply metadata retains bounded chronological neighbor context',{skip:!url},async t=>{
 const source=await fixture(t,{legacy:true});
 const context=await readCollectorContext(source,'tg',ref,at);
 assert.deepEqual(context.map(row=>row.evidenceRef),['tg:message:-100123:18','tg:message:-100123:19']);
 assert.deepEqual(await readCollectorContext(source,'x','x:tweet:20',at),[]);
});
