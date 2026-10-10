import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import type {PoolClient} from 'pg';
import {ingestTransaction,putEmbedding} from '../lib/trade/intelligence-blockchain';
test('chain evidence preserves decimal precision and does not claim account ownership',async()=>{
 const db=new PGlite();try{
  for(const name of ['023_intelligence_platform.sql','024_intelligence_temporal.sql'])await db.exec(await fs.readFile('migrations/'+name,'utf8'));
  const c={query:(sql:string,args:unknown[])=>db.query(sql,args)} as unknown as Pick<PoolClient,'query'>;
  const tx={chain:'ethereum',hash:'0x'+'a'.repeat(64),from:'0x'+'b'.repeat(40),to:'0x'+'c'.repeat(40),token:null,amount:'12345678901234567890.000000000000000001',timestamp:'2026-10-10T00:00:00Z',source:'https://example.org/chain',payload:{receipt:'fixture'}};
  const first=await ingestTransaction(c,tx);await ingestTransaction(c,tx);
  assert.equal((await db.query('SELECT * FROM ip_blockchain_transactions')).rows.length,1);
  assert.equal((await db.query<{amount:string}>('SELECT amount::text FROM ip_blockchain_transactions')).rows[0].amount,tx.amount);
  assert.equal((await db.query("SELECT * FROM ip_relation_evidence WHERE source_type='BLOCKCHAIN'")).rows.length,2);
  assert.equal((await db.query("SELECT * FROM ip_entity_relations WHERE relation_type='OWNS_WALLET'")).rows.length,0);
  await db.exec('BEGIN');await assert.rejects(ingestTransaction(c,{...tx,amount:'12345678901234567890.000000000000000002'}),/Conflicting/);await db.exec('ROLLBACK');
  await putEmbedding(c,first.from_entity,'fixture-model',[1,0]);await assert.rejects(putEmbedding(c,first.from_entity,'fixture-model',[NaN,0]));
  await assert.rejects(putEmbedding(c,first.from_entity,'fixture-model',[0,0]));
 }finally{await db.close();}
});
