import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {checkAccountQuotas} from '../autopost-quota-fixture';
test('real PostgreSQL: account-level quota planning retains all queue eligibility guards',{
 skip:!process.env.RUNTIME_TEST_DATABASE_URL,timeout:30_000,
},async()=>{
 const url=process.env.RUNTIME_TEST_DATABASE_URL!;assert(new URL(url).pathname.endsWith('_test'));
 const c=new Client({connectionString:url}),schema='quota_'+randomUUID().replaceAll('-','');await c.connect();
 try{await c.query('CREATE SCHEMA "'+schema+'"');await c.query('SET search_path TO "'+schema+'",public');await checkAccountQuotas(c);}
 finally{try{await c.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');}finally{await c.end();}}
});
