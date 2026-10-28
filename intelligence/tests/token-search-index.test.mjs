import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID}from'node:crypto';import pg from'pg';
import{collectTokenInputs}from'../scripts/token-analysis.mjs';
const url=process.env.INTELLIGENCE_TEST_DB_URL,mint='So11111111111111111111111111111111111111112';

test('Telegram token collection can use its existing trigram index without weakening case, boundary or cutoff checks',{skip:!url},async t=>{
 const admin=new pg.Pool({connectionString:url}),schema='token_search_'+randomUUID().replaceAll('-','');
 await admin.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');await admin.query('CREATE SCHEMA '+schema);
 const tg=new pg.Pool({connectionString:url,options:'-c search_path='+schema+',public -c enable_seqscan=off'});
 t.after(async()=>{await tg.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end()});
 await tg.query('CREATE TABLE tg_sources(id BIGINT,peer_id TEXT);CREATE TABLE tg_messages(source_id BIGINT,message_id BIGINT,text TEXT,collected_at TIMESTAMPTZ,posted_at TIMESTAMPTZ,deleted_at TIMESTAMPTZ,edited_at TIMESTAMPTZ);CREATE INDEX token_text_search ON tg_messages USING GIN(text gin_trgm_ops)');
 await tg.query("INSERT INTO tg_sources VALUES(1,'123')");
 const cutoff=new Date('2026-10-20T12:00:00Z'),past=new Date(cutoff.getTime()-1000),future=new Date(cutoff.getTime()+1000);
 const rows=[
  [1,'I would not buy '+mint,past,past,null,null],
  [2,'I would not buy 1'+mint,past,past,null,null],
  [3,'I would not buy '+mint.toLowerCase(),past,past,null,null],
  [4,'I would not buy '+mint,past,past,past,null],
  [5,'Edited later '+mint,past,past,null,future],
  [6,'Posted later '+mint,past,future,null,null],
  [7,'I expect growth '+mint,past,past,null,null]
 ];
 for(const row of rows)await tg.query('INSERT INTO tg_messages VALUES(1,$1,$2,$3,$4,$5,$6)',row);
 let selectedSql,selectedArgs;
 const tracked={connect:()=>tg.connect(),query:(sql,args)=>{selectedSql=sql;selectedArgs=args;return tg.query(sql,args)}};
 const sources={tg:tracked,x:{query:async()=>({rows:[]})},chain:{prepare:()=>({all:()=>[]})}};
 const result=await collectTokenInputs(sources,'solana:'+mint,cutoff);
 assert.deepEqual(new Set(result.messages.map(m=>m.evidenceRef)),new Set(['tg:message:123:1','tg:message:123:7']));
 const plan=(await tg.query('EXPLAIN (FORMAT JSON) '+selectedSql,selectedArgs)).rows[0]['QUERY PLAN'];
 const indexes=[];const visit=node=>{if(node['Index Name'])indexes.push(node['Index Name']);for(const child of node.Plans??[])visit(child)};visit(plan[0].Plan);
 assert(indexes.includes('token_text_search'),'the actual collector query must be indexable, not scan every stored message');
 await assert.rejects(collectTokenInputs(sources,'solana:'+mint.slice(0,-1)+'%',cutoff),/invalid_token_id/);
});
