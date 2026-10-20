import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrationChecksum,runMigrations} from '../lib/trade/migration-integrity';

test('migration checksum normalizes checkout CRLF but detects SQL changes',()=>{
 assert.equal(migrationChecksum('SELECT 1;\r\n'),migrationChecksum('SELECT 1;\n'));
 assert.notEqual(migrationChecksum('SELECT 1;'),migrationChecksum('SELECT 2;'));
});

test('checksums enforce preflight drift, read-only status, explicit legacy baseline and atomic rollback',async()=>{
 const db=new PGlite();
 const files=[{filename:'001.sql',sql:'CREATE TABLE fixture(id INT PRIMARY KEY);'},{filename:'002.sql',sql:'INSERT INTO fixture VALUES(1);'}];
 try{
  await runMigrations(db,files,{statusOnly:true});
  assert.equal((await db.query<{present:string|null}>("SELECT to_regclass('schema_migrations') present")).rows[0].present,null);
  await runMigrations(db,files);
  await runMigrations(db,files); // Never replay inserts on restart.
  assert.equal((await db.query('SELECT * FROM fixture')).rows.length,1);
  // An existing public ledger must not suppress migrations in a fresh schema.
  await db.exec('CREATE SCHEMA isolated; SET search_path TO isolated,public');
  const isolatedStatus:string[]=[];
  await runMigrations(db,files,{statusOnly:true,log:line=>isolatedStatus.push(line)});
  assert(isolatedStatus.every(line=>line.startsWith('[pending]')));
  assert.equal((await db.query<{present:string|null}>("SELECT to_regclass('isolated.schema_migrations') present")).rows[0].present,null);
  await runMigrations(db,files);
  assert.equal((await db.query('SELECT * FROM isolated.fixture')).rows.length,1);
  assert.equal((await db.query('SELECT * FROM isolated.schema_migrations')).rows.length,2);
  assert.equal((await db.query('SELECT * FROM public.schema_migrations')).rows.length,2);
  await db.exec('SET search_path TO public; DROP SCHEMA isolated CASCADE');
  const changed=[{...files[0],sql:'CREATE TABLE fixture(id TEXT);'},files[1],{filename:'003.sql',sql:'CREATE TABLE forbidden(id INT);'}];
  await assert.rejects(runMigrations(db,changed),/checksum drift: 001.sql/);
  await assert.rejects(runMigrations(db,changed,{baseline:true}),/checksum drift/);
  assert.equal((await db.query<{present:string|null}>("SELECT to_regclass('forbidden') present")).rows[0].present,null);
  await db.exec('ALTER TABLE schema_migrations DROP COLUMN checksum');
  const lines:string[]=[];
  await runMigrations(db,files,{statusOnly:true,log:line=>lines.push(line)});
  assert(lines.every(line=>line.startsWith('[unverified]')));
  await assert.rejects(db.query('SELECT checksum FROM schema_migrations'),/does not exist/);
  await assert.rejects(runMigrations(db,files),/unverified/);
  const pending=[...files,{filename:'003.sql',sql:'INSERT INTO fixture VALUES(2);'}];
  await runMigrations(db,pending,{baseline:true});
  assert.equal((await db.query('SELECT * FROM fixture')).rows.length,1);
  assert.equal((await db.query('SELECT checksum FROM schema_migrations WHERE checksum IS NOT NULL')).rows.length,2);
  await runMigrations(db,pending);
  await assert.rejects(runMigrations(db,[...pending,{filename:'004.sql',sql:'INSERT INTO fixture VALUES(3/0);'}]),/division by zero/);
  assert.equal((await db.query('SELECT * FROM fixture')).rows.length,2);
  assert.equal((await db.query("SELECT * FROM schema_migrations WHERE filename='004.sql'")).rows.length,0);
  await db.exec("INSERT INTO schema_migrations(filename) VALUES('unknown.sql')");
  await assert.rejects(runMigrations(db,pending,{baseline:true}),/Unknown applied migration/);
 }finally{await db.close();}
});
