#!/usr/bin/env node
"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"solana-source-rev-"));
const previous=process.cwd();
process.chdir(root);
require("ts-node").register({skipProject:true,transpileOnly:true,
 compilerOptions:{module:"commonjs",moduleResolution:"node",esModuleInterop:true}});
const {getDb}=require("../lib/trade/db");
const db=getDb();
try {
 const getRevision=()=>db.prepare("SELECT revision FROM database_source_revisions WHERE name='migration_wallet_rows'").get().revision;
 const insert=db.prepare(
  "INSERT INTO migration_wallet_rows(file_path,file_name,sheet_name,row_index,wallet,pnl,raw_json,imported_at) VALUES(?,?,?,?,?,?,?,?)");
 insert.run("file","file.xlsx","A",1,"wallet-one",10,"{}",1);
 insert.run("file","file.xlsx","A",2,"wallet-two",11,"{}",1);
 const maxRowid=()=>db.prepare("SELECT MAX(rowid) AS n FROM migration_wallet_rows").get().n;
 const before=getRevision(), max=maxRowid();
 db.prepare("UPDATE migration_wallet_rows SET pnl=42 WHERE wallet='wallet-one'").run();
 assert.equal(maxRowid(),max,"MAX(rowid) cannot detect UPDATE");
 assert.equal(getRevision(),before+1,"source revision must change on UPDATE");
 db.prepare("DELETE FROM migration_wallet_rows WHERE wallet='wallet-one'").run();
 assert.equal(maxRowid(),max,"MAX(rowid) cannot detect delete of older row");
 assert.equal(getRevision(),before+2,"source revision must change on DELETE");
 const otherBefore=db.prepare("SELECT revision FROM database_source_revisions WHERE name='wallet_tags'").get().revision;
 db.prepare("INSERT INTO wallet_tags(wallet,tag,updated_at) VALUES(?,?,?)").run("wallet-two","test",Date.now());
 assert.equal(db.prepare("SELECT revision FROM database_source_revisions WHERE name='wallet_tags'").get().revision,otherBefore+1);
 assert.equal(getDb(),db,"getDb must reuse initialized connection");
 console.log("[blockchain-sqlite-source-revisions] OK: DB-backed UPDATE/DELETE/INSERT invalidation even with unchanged MAX(rowid)");
} finally {
 db.close();
 global.__TRADE_DB__=undefined;
 process.chdir(previous);
 fs.rmSync(root,{recursive:true,force:true});
}
