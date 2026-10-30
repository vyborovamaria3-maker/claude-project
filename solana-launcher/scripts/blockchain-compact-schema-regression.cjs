'use strict';
const assert=require('node:assert/strict');
const {gunzipSync}=require('node:zlib');
const Database=require('better-sqlite3');
const collector=require('./blockchain-seed-collector.cjs');
const compact=require('./chain-raw-compact.cjs');
const db=new Database(':memory:');
process.env.BLOCKCHAIN_INTELLIGENCE_OUTBOX_ENABLED='false';
try {
 collector.initDb(db);
 const first={signature:'fixture-signature',timestamp:1,slot:2,value:'original'};
 const second={...first,value:'corrected'};
 collector.persistEvents(db,'wallet','fixture-wallet',[first]);
 compact.install(db);
 compact.migrateBatch(db);
 assert.equal(db.prepare("SELECT type FROM sqlite_master WHERE name='chain_seed_raw_revisions'").get().type,'view');
 assert.doesNotThrow(()=>collector.initDb(db),'reinitializing compact storage must not install table triggers on a view');
 collector.persistEvents(db,'wallet','fixture-wallet',[second]);
 const rows=db.prepare('SELECT raw_revision,payload_gzip FROM chain_seed_raw_revisions ORDER BY raw_revision').all();
 assert.equal(rows.length,2);
 assert.deepEqual(rows.map(row=>JSON.parse(gunzipSync(row.payload_gzip).toString())),[first,second]);
 assert.throws(()=>db.prepare('DELETE FROM chain_seed_raw_revisions').run(),/Immutable raw revision/);
 assert.throws(()=>db.prepare("UPDATE chain_seed_raw_revisions SET payload_hash='invalid'").run(),/Immutable raw revision/);
 assert.equal(collector.persistEvents(db,'wallet','fixture-wallet',[second]),0,'retries must remain idempotent');
 console.log('PASS compact Blockchain schema: initialization, revision preservation, immutability and retry idempotence');
} finally { db.close(); }
