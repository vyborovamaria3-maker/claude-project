import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {checkAutopostStatistics} from '../autopost-stats-fixture';
test('real PostgreSQL: autopost statistics SQL, Moscow-day grouping and account isolation',{
 skip:!process.env.RUNTIME_TEST_DATABASE_URL,timeout:30_000,
},async()=>{
 const url=process.env.RUNTIME_TEST_DATABASE_URL!;
 assert(new URL(url).pathname.endsWith('_test'),'Dedicated *_test database required');
 const client=new Client({connectionString:url});
 const schema='autopost_stats_'+randomUUID().replaceAll('-','');
 await client.connect();
 try{
  await client.query('CREATE SCHEMA "'+schema+'"');
  await client.query('SET search_path TO "'+schema+'"');
  await checkAutopostStatistics(client);
 }finally{
  try{await client.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');}finally{await client.end();}
 }
});
