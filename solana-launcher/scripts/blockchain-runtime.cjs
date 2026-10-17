"use strict";
// Shared by the existing CLI collector and server analytics; same trade.db.
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const fs = require('node:fs');
let database;
const defaults = { primary: 'default', fallback: '', batchSize: 20, concurrency: 2,
  requestsPerSecond: 2, timeoutMs: 12000, retries: 2, retryDelayMs: 500, enabled: true };
const slots = ['default', 'HELIUS_RPC_URL', 'RPC_URL', 'SOLANA_RPC_URL', 'PUBLIC_MAINNET'];
function db() {
  if (!database) {
    fs.mkdirSync(path.join(process.cwd(),'data'),{recursive:true});
    database = new Database(path.join(process.cwd(), 'data', 'trade.db'));
    database.pragma('busy_timeout=5000');
    database.exec(`CREATE TABLE IF NOT EXISTS blockchain_settings(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blockchain_http_leases(id TEXT PRIMARY KEY,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS blockchain_http_clock(id INTEGER PRIMARY KEY,next_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO blockchain_http_clock VALUES(1,0);
      CREATE TABLE IF NOT EXISTS blockchain_metrics(id INTEGER PRIMARY KEY,requests INTEGER DEFAULT 0,retries INTEGER DEFAULT 0,errors INTEGER DEFAULT 0,last_success INTEGER,last_error TEXT,latency INTEGER);
      INSERT OR IGNORE INTO blockchain_metrics(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS blockchain_imports(id TEXT PRIMARY KEY,name TEXT,category TEXT,sha256 TEXT,status TEXT,records INTEGER,invalid_rows INTEGER,error TEXT,created_at INTEGER);
      CREATE TABLE IF NOT EXISTS blockchain_runs(id TEXT PRIMARY KEY,started_at INTEGER,finished_at INTEGER,heartbeat_at INTEGER,state TEXT,targets INTEGER DEFAULT 0,events INTEGER DEFAULT 0,errors INTEGER DEFAULT 0);`);
  }
  return database;
}
function readSettings() {
  const row = db().prepare('SELECT json FROM blockchain_settings WHERE id=1').get();
  return { ...defaults, ...(row ? JSON.parse(row.json) : {}) };
}
function saveSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_settings');
  if (Object.keys(value).some(k => !Object.hasOwn(defaults,k))) throw new Error('unknown_setting');
  const next = { ...readSettings(), ...value };
  if (!slots.includes(next.primary) || !['', ...slots].includes(next.fallback)) throw new Error('invalid_rpc_slot');
  if (next.fallback && next.primary === next.fallback) throw new Error('duplicate_rpc_slot');
  for (const slot of [next.primary,next.fallback]) if (slot && !['default','PUBLIC_MAINNET'].includes(slot) && !process.env[slot]) throw new Error('rpc_not_configured');
  for (const [key,min,max] of [['batchSize',1,100],['concurrency',1,4],['requestsPerSecond',1,10],['timeoutMs',1000,30000],['retries',0,3],['retryDelayMs',100,10000]]) {
    if (!Number.isSafeInteger(next[key]) || next[key]<min || next[key]>max) throw new Error('invalid_'+key);
  }
  if (typeof next.enabled !== 'boolean') throw new Error('invalid_enabled');
  db().prepare('INSERT INTO blockchain_settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify(next));
  return next;
}
function rpcUrls(legacy) {
  const c = readSettings();
  const resolve = slot => slot === 'default' ? legacy : slot === 'PUBLIC_MAINNET' ? 'https://api.mainnet-beta.solana.com' : process.env[slot];
  return [...new Set([resolve(c.primary),c.fallback && resolve(c.fallback)].filter(Boolean))];
}
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function acquire(c) {
  const id=randomUUID(), deadline=Date.now()+60000;
  while (Date.now()<deadline) {
    const ok=db().transaction(()=>{
      const now=Date.now();db().prepare('DELETE FROM blockchain_http_leases WHERE expires<=?').run(now);
      if (db().prepare('SELECT COUNT(*) AS n FROM blockchain_http_leases').get().n>=c.concurrency) return false;
      if (db().prepare('SELECT next_at FROM blockchain_http_clock WHERE id=1').get().next_at>now) return false;
      db().prepare('UPDATE blockchain_http_clock SET next_at=? WHERE id=1').run(now+Math.ceil(1000/c.requestsPerSecond));
      db().prepare('INSERT INTO blockchain_http_leases VALUES(?,?)').run(id,now+c.timeoutMs+5000);
      return true;
    }).immediate();
    if (ok) return id;
    await sleep(50);
  }
  throw new Error('blockchain_queue_timeout');
}
async function jsonRequest(urls, init = {}) {
  if (!Array.isArray(urls)) urls=[urls];
  const c=readSettings();
  for (let attempt=0;attempt<=c.retries;attempt++) {
    const lease=await acquire(c), start=Date.now();
    let retryable=true;
    try {
      db().prepare('UPDATE blockchain_metrics SET requests=requests+1 WHERE id=1').run();
      const response=await fetch(urls[attempt%urls.length],{...init,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(c.timeoutMs)});
      if (!response.ok) { retryable=response.status===429 || response.status>=500;throw new Error('http_'+response.status); }
      const result=await response.json();
      if (result && result.error) {
        retryable=[-32005,-32004,-32429].includes(result.error.code);
        throw new Error('rpc_error');
      }
      db().prepare('UPDATE blockchain_metrics SET last_success=?,last_error=NULL,latency=? WHERE id=1').run(Date.now(),Date.now()-start);
      return result;
    } catch (error) {
      const code=/^http_\d{3}$/.test(error.message) ? error.message : error.message==='rpc_error' ? 'rpc_error' : 'transport_error';
      db().prepare('UPDATE blockchain_metrics SET errors=errors+1,last_error=? WHERE id=1').run(code);
      if (!retryable || attempt===c.retries) throw new Error(code);
      db().prepare('UPDATE blockchain_metrics SET retries=retries+1 WHERE id=1').run();
    } finally { db().prepare('DELETE FROM blockchain_http_leases WHERE id=?').run(lease); }
    await sleep(Math.min(10000,c.retryDelayMs*2**attempt));
  }
}
async function rpcRequest(legacy,body) {
  return jsonRequest(rpcUrls(legacy),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
}
function publicSettings() {
  return { values:readSettings(),slots:slots.map(name=>({name,configured:['default','PUBLIC_MAINNET'].includes(name)||Boolean(process.env[name])})),
    heliusConfigured:Boolean(process.env.HELIUS_API_KEY || process.env.HELIUS_API_KEYS || process.env.HELIUS_RPC_URL),
    metrics:db().prepare('SELECT * FROM blockchain_metrics WHERE id=1').get() };
}
module.exports={db,defaults,readSettings,saveSettings,rpcUrls,jsonRequest,rpcRequest,publicSettings};
