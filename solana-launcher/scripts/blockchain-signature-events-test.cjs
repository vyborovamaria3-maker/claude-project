"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gunzipSync } = require("node:zlib");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { prepare, migrate, plan, load, args } = require("./blockchain-signature-events.cjs");
(async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "signature-events-"));
 try {
  const file = path.join(dir, "trade.db"), backup = path.join(dir, "backup.db");
  let db = new Database(file);
  db.pragma("journal_mode=WAL");
  db.exec(`CREATE TABLE token_trades (mint TEXT,signature TEXT,timestamp INTEGER,trader TEXT,type TEXT,amount_sol REAL,amount_tokens REAL,price_sol REAL,source TEXT);
    INSERT INTO token_trades VALUES('mint','ok',1,'wallet','buy',1,2,0.5,'fixture');
    INSERT INTO token_trades SELECT 'other',signature,timestamp,trader,type,amount_sol,amount_tokens,price_sol,source FROM token_trades;
    INSERT INTO token_trades SELECT mint,'failed',timestamp,trader,type,amount_sol,amount_tokens,price_sol,source FROM token_trades WHERE mint='mint';`);
  assert.deepEqual(plan(db, "mint", 1), ["failed"]);
  await prepare(file, backup); // online SQLite backup includes committed WAL
  const copy = new Database(backup, { readonly: true });
  assert.equal(copy.prepare("SELECT count(*) n FROM token_trades").get().n, 3);
  assert.equal(copy.pragma("table_info(token_trades)").some(c=>c.name==='slot'), false);
  copy.close();
  await assert.rejects(prepare(file, backup));
  migrate(db); migrate(db);
  assert.equal(db.prepare("SELECT count(*) n FROM token_trades").get().n, 3);
  assert.equal(db.prepare("SELECT count(*) n FROM token_trades WHERE slot IS NOT NULL").get().n, 0);
  const calls = [];
  const rpc = async (method, params) => {
   calls.push([method,params]); const sig=params[0];
   if(sig==='missing') return {result:null};
   if(sig==='error') throw Error('secret must not appear');
   if(sig==='bad') return {result:{transaction:{signatures:['different']}}};
   return {result:{slot:12,blockTime:1700000000,transaction:{signatures:[sig],message:{accountKeys:[],instructions:[]}},meta:{err:sig==='failed'?{InstructionError:[0,'failed']}:null,preTokenBalances:[],postTokenBalances:[]}}};
  };
  const r=await load(db,'mint',['ok','failed','missing','bad','error'],rpc);
  assert.equal(r.saved,2); assert.deepEqual(r.missing,['missing']); assert.deepEqual(r.rejected,['bad']); assert.deepEqual(r.failed,['error']);
  assert.ok(calls.every(c=>c[0]==='getTransaction' && c[1][1].commitment==='finalized'));
  const event=JSON.parse(gunzipSync(db.prepare("SELECT payload_gzip FROM chain_seed_events WHERE signature='failed'").get().payload_gzip));
  assert.ok(event.transactionError); assert.equal(event.signature,'failed');
  assert.deepEqual(plan(db,'mint',10),[]);
  assert.deepEqual(plan(db,'other',10),['ok']);
  assert.equal((await load(db,'mint',['ok'],rpc)).saved,0);
  db.close();
  const before=fs.readFileSync(file);
  const cli=spawnSync(process.execPath,[path.join(__dirname,'blockchain-signature-events.cjs'),'--db',file,'--mint','other'],{encoding:'utf8',env:{...process.env,ALCHEMY_SOLANA_RPC_URL:'https://invalid.invalid'}});
  assert.equal(cli.status,0,cli.stderr); assert.equal(JSON.parse(cli.stdout).networkRequests,0);
  assert.deepEqual(fs.readFileSync(file),before);
  assert.throws(()=>args(['--db',file,'--mint','mint','--limit','101']));
  assert.throws(()=>args(['--db',file,'--prepare','--backup',backup,'--execute']));
  console.log('[blockchain-signature-events] OK: WAL backup, migration, bounded plans, mocked RPC, failed/null/mismatched results, idempotency, offline CLI');
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1});
