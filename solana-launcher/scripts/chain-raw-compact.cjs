'use strict';
// Lossless revision storage. Latest bytes remain in chain_seed_events; older
// versions move to immutable blob storage before the latest bytes can change.
const {createHash}=require('node:crypto');
const fields=['kind','address','signature','raw_revision','payload_hash','payload_gzip','payload_bytes','observed_at','block_time','slot'];
const meta=fields.filter(x=>x!=='payload_gzip');
const key=['kind','address','signature','raw_revision'];
const eq=(a,b,cols)=>cols.map(x=>`${a}.${x} IS ${b}.${x}`).join(' AND ');
const caches=new WeakMap();
function statements(db){
 if(caches.has(db))return caches.get(db);
 const s={
  existing:db.prepare('SELECT '+fields.join(',')+' FROM chain_seed_raw_revisions WHERE '+key.map(x=>x+'=?').join(' AND ')),
  current:db.prepare('SELECT payload_gzip FROM chain_seed_events WHERE kind=? AND address=? AND signature=?'),
  putBlob:db.prepare('INSERT OR IGNORE INTO chain_raw_payload_blobs VALUES(?,?)'),
  getBlob:db.prepare('SELECT payload_gzip FROM chain_raw_payload_blobs WHERE payload_key=?'),
  putRef:db.prepare('INSERT INTO chain_raw_revision_refs('+meta.join(',')+',payload_key,source_current) VALUES('+Array(meta.length+2).fill('?').join(',')+')'),
  batch:db.prepare('SELECT rowid AS legacy_rowid,'+fields.join(',')+' FROM chain_seed_raw_revisions_legacy ORDER BY rowid LIMIT ?'),
  remove:db.prepare('DELETE FROM chain_seed_raw_revisions_legacy WHERE rowid=?'),pending:[]
 };
 caches.set(db,s);return s;
}
function enabled(db){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chain_raw_compact_meta'").get();}
function legacySchema(sql){
 const start=sql.indexOf(';CREATE TABLE IF NOT EXISTS chain_seed_raw_revisions');
 const end=sql.indexOf(';CREATE INDEX IF NOT EXISTS idx_chain_seed_events_latest',start);
 if(start<0||end<0)throw Error('Revision schema boundary missing');
 return sql.slice(0,start)+sql.slice(end);
}
function install(db){
 if(enabled(db))return false;
 if(db.inTransaction)throw Error('Install must own a short transaction');
 return db.transaction(()=>{
  db.exec(`CREATE TABLE chain_raw_compact_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   INSERT INTO chain_raw_compact_meta VALUES('version','1');
   CREATE TABLE chain_raw_payload_blobs(payload_key TEXT PRIMARY KEY,payload_gzip BLOB NOT NULL);
   CREATE TRIGGER chain_raw_blob_no_update BEFORE UPDATE ON chain_raw_payload_blobs BEGIN SELECT RAISE(ABORT,'Immutable raw payload'); END;
   CREATE TRIGGER chain_raw_blob_no_delete BEFORE DELETE ON chain_raw_payload_blobs BEGIN SELECT RAISE(ABORT,'Immutable raw payload'); END;
   CREATE TRIGGER chain_raw_blob_no_replace BEFORE INSERT ON chain_raw_payload_blobs
    WHEN EXISTS(SELECT 1 FROM chain_raw_payload_blobs WHERE payload_key=NEW.payload_key AND payload_gzip IS NOT NEW.payload_gzip)
    BEGIN SELECT RAISE(ABORT,'Conflicting raw payload'); END;
   ALTER TABLE chain_seed_raw_revisions RENAME TO chain_seed_raw_revisions_legacy;
   CREATE TABLE chain_raw_revision_refs(
    kind TEXT NOT NULL,address TEXT NOT NULL,signature TEXT NOT NULL,raw_revision INTEGER NOT NULL CHECK(raw_revision>0),
    payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),payload_key TEXT NOT NULL,payload_bytes INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,block_time INTEGER,slot INTEGER,source_current INTEGER NOT NULL CHECK(source_current IN(0,1)),
    PRIMARY KEY(kind,address,signature,raw_revision));
   CREATE INDEX idx_chain_raw_refs_current ON chain_raw_revision_refs(kind,address,signature) WHERE source_current=1;
   CREATE INDEX idx_chain_raw_refs_hash ON chain_raw_revision_refs(kind,address,signature,payload_hash);
   CREATE TRIGGER chain_raw_refs_no_delete BEFORE DELETE ON chain_raw_revision_refs BEGIN SELECT RAISE(ABORT,'Immutable raw revision'); END;
   CREATE TRIGGER chain_raw_refs_no_replace BEFORE INSERT ON chain_raw_revision_refs
    WHEN EXISTS(SELECT 1 FROM chain_raw_revision_refs r WHERE ${eq('r','NEW',key)})
    BEGIN SELECT RAISE(ABORT,'Immutable raw revision'); END;
   CREATE TRIGGER chain_raw_refs_no_update BEFORE UPDATE ON chain_raw_revision_refs
    WHEN NOT(OLD.source_current=1 AND NEW.source_current=0 AND ${eq('OLD','NEW',[...meta,'payload_key'])}
     AND EXISTS(SELECT 1 FROM chain_raw_payload_blobs p JOIN chain_seed_events e
      ON e.kind=OLD.kind AND e.address=OLD.address AND e.signature=OLD.signature
      WHERE p.payload_key=OLD.payload_key AND p.payload_gzip IS e.payload_gzip))
    BEGIN SELECT RAISE(ABORT,'Immutable raw revision'); END;
   CREATE VIEW chain_seed_raw_revisions AS
    SELECT ${fields.map(x=>x==='payload_gzip'?'CASE WHEN r.source_current=1 THEN e.payload_gzip ELSE b.payload_gzip END AS payload_gzip':'r.'+x).join(',')}
    FROM chain_raw_revision_refs r LEFT JOIN chain_seed_events e ON r.source_current=1 AND e.kind=r.kind AND e.address=r.address AND e.signature=r.signature
    LEFT JOIN chain_raw_payload_blobs b ON r.source_current=0 AND b.payload_key=r.payload_key
    UNION ALL SELECT ${fields.join(',')} FROM chain_seed_raw_revisions_legacy;
   CREATE TRIGGER chain_raw_view_no_insert INSTEAD OF INSERT ON chain_seed_raw_revisions BEGIN SELECT RAISE(ABORT,'Immutable raw revision; use compact raw writer'); END;
   CREATE TRIGGER chain_raw_view_no_update INSTEAD OF UPDATE ON chain_seed_raw_revisions BEGIN SELECT RAISE(ABORT,'Immutable raw revision'); END;
   CREATE TRIGGER chain_raw_view_no_delete INSTEAD OF DELETE ON chain_seed_raw_revisions BEGIN SELECT RAISE(ABORT,'Immutable raw revision'); END;
   DROP TRIGGER IF EXISTS chain_raw_revisions_no_delete;
   CREATE TRIGGER chain_raw_legacy_safe_delete BEFORE DELETE ON chain_seed_raw_revisions_legacy
    WHEN NOT EXISTS(SELECT 1 FROM chain_raw_revision_refs r
     LEFT JOIN chain_seed_events e ON r.source_current=1 AND e.kind=r.kind AND e.address=r.address AND e.signature=r.signature
     LEFT JOIN chain_raw_payload_blobs b ON r.source_current=0 AND b.payload_key=r.payload_key
     WHERE ${eq('r','OLD',meta)} AND CASE WHEN r.source_current=1 THEN e.payload_gzip ELSE b.payload_gzip END IS OLD.payload_gzip)
    BEGIN SELECT RAISE(ABORT,'Cannot discard unverified legacy raw'); END;`);
  for(const operation of ['UPDATE','DELETE']){
   const name=operation.startsWith('UPDATE')?'update':'delete';
   db.exec(`CREATE TRIGGER chain_raw_preserve_before_${name} BEFORE ${operation} ON chain_seed_events BEGIN
    INSERT OR IGNORE INTO chain_raw_payload_blobs(payload_key,payload_gzip)
     SELECT payload_key,OLD.payload_gzip FROM chain_raw_revision_refs
     WHERE kind=OLD.kind AND address=OLD.address AND signature=OLD.signature AND source_current=1;
    UPDATE chain_raw_revision_refs SET source_current=0 WHERE kind=OLD.kind AND address=OLD.address AND signature=OLD.signature AND source_current=1;
    END;`);
  }
  // REPLACE can delete an old row without firing DELETE triggers when recursive
  // triggers are disabled. Capture the old bytes before any conflicting INSERT.
  db.exec(`CREATE TRIGGER chain_raw_preserve_before_insert BEFORE INSERT ON chain_seed_events
   WHEN EXISTS(SELECT 1 FROM chain_seed_events e WHERE e.kind=NEW.kind AND e.address=NEW.address AND e.signature=NEW.signature AND e.payload_gzip IS NOT NEW.payload_gzip)
   BEGIN
    INSERT OR IGNORE INTO chain_raw_payload_blobs(payload_key,payload_gzip)
     SELECT r.payload_key,e.payload_gzip FROM chain_raw_revision_refs r JOIN chain_seed_events e
     ON e.kind=r.kind AND e.address=r.address AND e.signature=r.signature
     WHERE r.kind=NEW.kind AND r.address=NEW.address AND r.signature=NEW.signature AND r.source_current=1;
    UPDATE chain_raw_revision_refs SET source_current=0 WHERE kind=NEW.kind AND address=NEW.address AND signature=NEW.signature AND source_current=1;
   END;`);
  return true;
 }).immediate();
}
function archive(db,row){
 if(!db.inTransaction)throw Error('Raw archival must share the source transaction');
 const args=key.map(x=>row[x]);
 const existing=statements(db).existing.get(...args);
 if(existing){
  if(meta.some(x=>existing[x]!==row[x])||!Buffer.from(existing.payload_gzip).equals(Buffer.from(row.payload_gzip)))throw Error('Conflicting immutable raw revision snapshot');
  // A legacy row is already durable. Migration will compact it, not duplicate it.
  return;
 }
 insertRef(db,row);
}
function insertRef(db,row){
 const s=statements(db),current=s.current.get(row.kind,row.address,row.signature);
 const same=!!current&&Buffer.from(current.payload_gzip).equals(Buffer.from(row.payload_gzip));
 const payloadKey=createHash('sha256').update(row.payload_gzip).digest('hex');
 if(!same){
  s.putBlob.run(payloadKey,row.payload_gzip);
  const stored=s.getBlob.get(payloadKey);
  if(!stored||!Buffer.from(stored.payload_gzip).equals(Buffer.from(row.payload_gzip)))throw Error('Conflicting raw payload');
 }
 s.putRef.run(...meta.map(x=>row[x]),payloadKey,same?1:0);
}
function migrateBatch(db,{limit=16,maxMs=75}={}){
 if(!enabled(db))throw Error('Compact storage not installed');
 if(!Number.isInteger(limit)||limit<1||limit>1000)throw Error('Invalid migration batch');
 const started=Date.now();let rows=0,bytes=0;
 // Prefetch immutable legacy rows without taking the writer reservation.
 const s=statements(db);
 const batch=s.pending.length?s.pending:s.batch.all(limit);
 db.transaction(()=>{
  const lockedAt=Date.now();
  for(const row of batch){
   if(rows>=limit)break;
   if(rows&&Date.now()-lockedAt>maxMs)break;
   insertRef(db,row);
   // The SQL delete guard checks all metadata AND the entire original BLOB.
   s.remove.run(row.legacy_rowid);
   rows++;bytes+=row.payload_gzip.length;
  }
 }).immediate();
 s.pending=batch.slice(rows);
 return {rows,bytes,elapsedMs:Date.now()-started};
}
module.exports={enabled,legacySchema,install,archive,migrateBatch};
